from collections import Counter
import json
import re
import subprocess
import unittest
from functools import cache
from pathlib import Path

ROOT = Path(__file__).parents[1]


@cache
def compiled_main():
    result = subprocess.run(
        ["bicep", "build", str(ROOT / "infra" / "main.bicep"), "--stdout"],
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(result.stdout), result.stderr


def load_test_template(template):
    load_test = next(
        resource
        for resource in template["resources"]
        if resource["type"] == "Microsoft.Resources/deployments"
        and resource.get("condition") == "[parameters('iotFactoryLoadTest')]"
    )
    return load_test["properties"]["template"]


def resources(template):
    found = template.get("resources", [])
    return list(found.values()) if isinstance(found, dict) else found


def nested_templates(template):
    yield template
    for resource in resources(template):
        if resource.get("type") == "Microsoft.Resources/deployments":
            nested = resource.get("properties", {}).get("template")
            if nested:
                yield from nested_templates(nested)


_ARM_TOKEN = re.compile(
    r"\s*(?:(?P<string>'[^']*')|(?P<number>\d+)|"
    r"(?P<identifier>[A-Za-z_][A-Za-z0-9_]*)|(?P<symbol>[\(\)\[\]\.,]))"
)


@cache
def parse_arm_expression(expression):
    source = expression[1:-1] if expression.startswith("[") and expression.endswith("]") else expression
    tokens = []
    position = 0
    while position < len(source):
        match = _ARM_TOKEN.match(source, position)
        if not match:
            raise AssertionError(f"Unsupported compiled ARM expression: {source}")
        kind = next(name for name, value in match.groupdict().items() if value is not None)
        token = match.group(kind)
        tokens.append((kind, token[1:-1] if kind == "string" else token))
        position = match.end()

    def parse():
        nonlocal tokens
        if not tokens:
            raise AssertionError(f"Incomplete compiled ARM expression: {source}")
        kind, value = tokens.pop(0)
        if kind == "string":
            result = ("literal", value)
        elif kind == "number":
            result = ("literal", int(value))
        elif kind == "identifier":
            name = value
            if (
                len(tokens) >= 3
                and tokens[0] == ("symbol", ".")
                and tokens[1][0] == "identifier"
                and tokens[2] == ("symbol", "(")
            ):
                name = f"{name}.{tokens[1][1]}"
                del tokens[:2]
            if tokens and tokens[0] == ("symbol", "("):
                tokens.pop(0)
                arguments = []
                if not tokens or tokens[0] != ("symbol", ")"):
                    while True:
                        arguments.append(parse())
                        if tokens and tokens[0] == ("symbol", ","):
                            tokens.pop(0)
                            continue
                        break
                if not tokens or tokens.pop(0) != ("symbol", ")"):
                    raise AssertionError(f"Unclosed compiled ARM function in: {source}")
                result = ("call", name, tuple(arguments))
            else:
                result = ("name", name)
        elif kind == "symbol" and value == "(":
            result = parse()
            if not tokens or tokens.pop(0) != ("symbol", ")"):
                raise AssertionError(f"Unclosed compiled ARM group in: {source}")
        else:
            raise AssertionError(f"Unsupported compiled ARM token in: {source}")

        while tokens:
            if tokens[0] == ("symbol", "."):
                tokens.pop(0)
                if not tokens or tokens[0][0] != "identifier":
                    raise AssertionError(f"Invalid compiled ARM property in: {source}")
                result = ("member", result, tokens.pop(0)[1])
            elif tokens[0] == ("symbol", "["):
                tokens.pop(0)
                index = parse()
                if not tokens or tokens.pop(0) != ("symbol", "]"):
                    raise AssertionError(f"Unclosed compiled ARM index in: {source}")
                result = ("index", result, index)
            else:
                break
        return result

    expression_tree = parse()
    if tokens:
        raise AssertionError(f"Unexpected compiled ARM tokens in: {source}")
    return expression_tree


class CompiledArmEvaluator:
    def __init__(self, template):
        self.template = template
        self.parameters = {
            name: parameter["defaultValue"]
            for name, parameter in template.get("parameters", {}).items()
            if "defaultValue" in parameter
        }
        self.variables = template.get("variables", {})
        self.functions = {
            name: function
            for namespace in template.get("functions", [])
            for name, function in namespace["members"].items()
        }
        self.references = {}
        self.function_cache = {}

    def evaluate(
        self,
        value,
        parameters=None,
        variables=None,
        copy_indices=None,
        lambda_variables=None,
    ):
        parameters = self.parameters if parameters is None else parameters
        variables = self.variables if variables is None else variables
        copy_indices = {} if copy_indices is None else copy_indices
        lambda_variables = {} if lambda_variables is None else lambda_variables
        if isinstance(value, str) and value.startswith("[") and value.endswith("]"):
            return self._evaluate_tree(
                parse_arm_expression(value),
                parameters,
                variables,
                copy_indices,
                lambda_variables,
            )
        if isinstance(value, dict):
            return {
                key: self.evaluate(
                    child, parameters, variables, copy_indices, lambda_variables
                )
                for key, child in value.items()
            }
        if isinstance(value, list):
            return [
                self.evaluate(child, parameters, variables, copy_indices, lambda_variables)
                for child in value
            ]
        return value

    def _evaluate_tree(self, tree, parameters, variables, copy_indices, lambda_variables):
        kind = tree[0]
        if kind == "literal":
            return tree[1]
        if kind == "name":
            raise AssertionError(f"Unsupported compiled ARM name: {tree[1]}")
        if kind == "member":
            return self._evaluate_tree(
                tree[1], parameters, variables, copy_indices, lambda_variables
            )[tree[2]]
        if kind == "index":
            target = self._evaluate_tree(
                tree[1], parameters, variables, copy_indices, lambda_variables
            )
            index = self._evaluate_tree(
                tree[2], parameters, variables, copy_indices, lambda_variables
            )
            return target[index]

        name, arguments = tree[1], tree[2]
        if name == "lambda":
            parameter = self._evaluate_tree(
                arguments[0], parameters, variables, copy_indices, lambda_variables
            )
            return (
                "lambda",
                parameter,
                arguments[1],
                parameters,
                variables,
                copy_indices,
                lambda_variables,
            )
        if name == "if":
            condition = self._evaluate_tree(
                arguments[0], parameters, variables, copy_indices, lambda_variables
            )
            return self._evaluate_tree(
                arguments[1] if condition else arguments[2],
                parameters,
                variables,
                copy_indices,
                lambda_variables,
            )
        if name == "parameters":
            parameter = self._evaluate_tree(
                arguments[0], parameters, variables, copy_indices, lambda_variables
            )
            return parameters[parameter]
        if name == "variables":
            variable = self._evaluate_tree(
                arguments[0], parameters, variables, copy_indices, lambda_variables
            )
            return self.evaluate(
                variables[variable], parameters, variables, copy_indices, lambda_variables
            )
        if name == "lambdaVariables":
            variable = self._evaluate_tree(
                arguments[0], parameters, variables, copy_indices, lambda_variables
            )
            return lambda_variables[variable]
        if name == "copyIndex":
            index_name = (
                self._evaluate_tree(
                    arguments[0], parameters, variables, copy_indices, lambda_variables
                )
                if arguments
                else None
            )
            return copy_indices[index_name]

        values = [
            self._evaluate_tree(
                argument, parameters, variables, copy_indices, lambda_variables
            )
            for argument in arguments
        ]
        if name.startswith("__bicep."):
            return self._evaluate_function(
                name.split(".", 1)[1], values, copy_indices
            )
        if name == "add":
            return values[0] + values[1]
        if name == "sub":
            return values[0] - values[1]
        if name == "mul":
            return values[0] * values[1]
        if name == "div":
            return values[0] // values[1]
        if name == "mod":
            return values[0] % values[1]
        if name == "less":
            return values[0] < values[1]
        if name == "greaterOrEquals":
            return values[0] >= values[1]
        if name == "and":
            return all(values)
        if name == "format":
            return values[0].format(*values[1:])
        if name == "first":
            return values[0][0] if values[0] else None
        if name == "coalesce":
            return next((value for value in values if value is not None), None)
        if name == "filter":
            return [
                item
                for item in values[0]
                if self._apply_lambda(values[1], item)
            ]
        if name == "map":
            return [self._apply_lambda(values[1], item) for item in values[0]]
        if name == "range":
            return list(range(values[0], values[0] + values[1]))
        if name == "length":
            return len(values[0])
        if name == "min":
            return min(values)
        if name == "createObject":
            return dict(zip(values[::2], values[1::2]))
        if name == "reference":
            return self.references[values[0]]
        raise AssertionError(f"Unsupported compiled ARM function: {name}")

    def _apply_lambda(self, function, value):
        _, name, body, parameters, variables, copy_indices, outer_variables = function
        lambda_variables = {**outer_variables, name: value}
        return self._evaluate_tree(
            body, parameters, variables, copy_indices, lambda_variables
        )

    def _evaluate_function(self, name, values, copy_indices):
        cache_key = None
        if name in ("layerFor", "primaryParentIndex"):
            cache_key = (name, values[0], values[1], id(values[2]))
            if cache_key in self.function_cache:
                return self.function_cache[cache_key]
        function = self.functions[name]
        parameters = {
            parameter["name"]: value
            for parameter, value in zip(function["parameters"], values)
        }
        result = self.evaluate(
            function["output"]["value"],
            parameters,
            self.variables,
            copy_indices,
        )
        if cache_key is not None:
            self.function_cache[cache_key] = result
        return result


class IoTFactoryLoadTestContractTests(unittest.TestCase):
    def test_C1_opt_in_creates_a_separate_model_without_changing_production_outputs(self):
        template, _ = compiled_main()

        self.assertEqual(template["parameters"]["iotFactoryLoadTest"]["defaultValue"], False)
        load_test = next(
            resource
            for resource in template["resources"]
            if resource["type"] == "Microsoft.Resources/deployments"
            and resource.get("condition") == "[parameters('iotFactoryLoadTest')]"
        )
        self.assertEqual(load_test["name"], "iot-factory-health-model")
        self.assertEqual(
            load_test["properties"]["parameters"]["modelName"]["value"],
            "[variables('iotFactoryHealthModelName')]",
        )
        self.assertEqual(
            template["variables"]["iotFactoryHealthModelName"],
            "[format('hm-{0}-iot-factory', parameters('environmentName'))]",
        )
        self.assertEqual(
            template["variables"]["healthModelName"],
            "[format('hm-{0}', variables('namePrefix'))]",
        )
        self.assertEqual(
            template["variables"]["designHealthModelName"],
            "[format('hm-{0}-design', variables('namePrefix'))]",
        )

    def test_C2_default_profile_expands_to_twenty_semantic_levels_and_eight_thousand_entities(self):
        template, _ = compiled_main()
        load_test = load_test_template(template)
        layer_specs = load_test["variables"]["layerSpecs"]

        self.assertEqual(len(layer_specs), 20)
        self.assertEqual(sum(layer["count"] for layer in layer_specs), 8000)
        self.assertEqual(
            [layer["name"] for layer in layer_specs],
            [
                "portfolio",
                "regions",
                "countries",
                "factory-sites",
                "campuses",
                "plants",
                "buildings",
                "production-halls",
                "production-lines",
                "work-cells",
                "machine-islands",
                "machines",
                "machine-controllers",
                "plcs",
                "sensor-gateways",
                "device-racks",
                "devices",
                "sensors",
                "telemetry-channels",
                "observations",
            ],
        )
        self.assertEqual(
            [(layer["level"], layer["firstIndex"]) for layer in layer_specs],
            [
                (level, start)
                for level, start in enumerate(
                    [0, 1, 3, 7, 15, 31, 63, 127, 255, 511, 1023, 1535, 2047, 2559, 3071, 3583, 4095, 4607, 5119, 5631]
                )
            ],
        )
        for name, expected in (("entityCount", 8000), ("levelCount", 20)):
            with self.subTest(parameter=name):
                parameter = load_test["parameters"][name]
                self.assertEqual(parameter["defaultValue"], expected)
                self.assertEqual(parameter["minValue"], expected)
                self.assertEqual(parameter["maxValue"], expected)

    def test_C3_C7_compiled_relationships_form_the_expected_reachable_dag(self):
        template, _ = compiled_main()
        load_test = load_test_template(template)
        evaluator = CompiledArmEvaluator(load_test)
        entity_module = next(
            resource
            for resource in resources(load_test)
            if resource["type"] == "Microsoft.Resources/deployments"
            and "iot-factory-entities" in resource["name"]
        )
        entity_input = entity_module["properties"]["parameters"]["entities"]["copy"][0]
        entity_output = entity_module["properties"]["template"]["outputs"]["entityNames"]["copy"]
        entity_outputs = {}
        entity_names = []
        entity_batch_count = evaluator.evaluate(entity_module["copy"]["count"])
        for batch_index in range(entity_batch_count):
            entity_count = evaluator.evaluate(
                entity_input["count"], copy_indices={None: batch_index}
            )
            entities = [
                evaluator.evaluate(
                    entity_input["input"],
                    copy_indices={None: batch_index, "value": local_index},
                )
                for local_index in range(entity_count)
            ]
            output_count = evaluator.evaluate(
                entity_output["count"], parameters={"entities": entities}
            )
            names = [
                evaluator.evaluate(
                    entity_output["input"],
                    parameters={"entities": entities},
                    copy_indices={None: output_index},
                )
                for output_index in range(output_count)
            ]
            entity_outputs[f"entityBatch[{batch_index}]"] = {
                "outputs": {"entityNames": {"value": names}}
            }
            entity_names.extend(names)
        evaluator.references = entity_outputs

        relationship_module = next(
            resource
            for resource in resources(load_test)
            if resource["type"] == "Microsoft.Resources/deployments"
            and "iot-factory-relationships" in resource["name"]
        )
        relationship_input = relationship_module["properties"]["parameters"]["relationships"]["copy"][0]
        relationship_batch_count = evaluator.evaluate(relationship_module["copy"]["count"])
        relationships = []
        for batch_index in range(relationship_batch_count):
            relationship_count = evaluator.evaluate(
                relationship_input["count"], copy_indices={None: batch_index}
            )
            relationships.extend(
                evaluator.evaluate(
                    relationship_input["input"],
                    copy_indices={None: batch_index, "value": local_index},
                )
                for local_index in range(relationship_count)
            )

        entity_index = {name: index for index, name in enumerate(entity_names)}
        self.assertEqual(len(entity_names), 8000)
        self.assertEqual(len(entity_index), len(entity_names))
        self.assertEqual(len(relationships), 8799)
        primary = [item for item in relationships if item["name"].startswith("primary-")]
        cross_links = [item for item in relationships if item["name"].startswith("cross-")]
        self.assertEqual(len(primary), 7999)
        self.assertEqual(len(cross_links), 800)
        self.assertEqual(len(primary) + len(cross_links), len(relationships))

        missing_endpoints = [
            (item["name"], item["parentEntityName"], item["childEntityName"])
            for item in relationships
            if item["parentEntityName"] not in entity_index
            or item["childEntityName"] not in entity_index
        ]
        self.assertEqual(missing_endpoints, [])
        edges = [
            (entity_index[item["parentEntityName"]], entity_index[item["childEntityName"]])
            for item in relationships
        ]
        self.assertEqual(len(set(edges)), 8799)
        parents = [[] for _ in entity_names]
        children = [[] for _ in entity_names]
        for parent, child in edges:
            self.assertLess(parent, child)
            parents[child].append(parent)
            children[parent].append(child)

        self.assertEqual(max(map(len, parents)), 2)
        reached = {0}
        pending = [0]
        while pending:
            for child in children[pending.pop()]:
                if child not in reached:
                    reached.add(child)
                    pending.append(child)
        self.assertEqual(len(reached), len(entity_names))

        depth = [0] * len(entity_names)
        for child in range(len(entity_names)):
            depth[child] = max((depth[parent] + 1 for parent in parents[child]), default=0)
        self.assertEqual(max(depth), 19)

    def test_C4_batches_limit_resource_loops_and_avoid_authored_dependsOn(self):
        template, _ = compiled_main()
        load_test = load_test_template(template)
        batch_parameter = load_test["parameters"]["batchSize"]
        self.assertEqual(batch_parameter["defaultValue"], 400)
        self.assertEqual(batch_parameter["minValue"], 22)
        self.assertEqual(batch_parameter["maxValue"], 400)

        templates = list(nested_templates(template))
        for parameter_name, resource_type in (
            ("entities", "Microsoft.CloudHealth/healthmodels/entities"),
            ("relationships", "Microsoft.CloudHealth/healthmodels/relationships"),
        ):
            with self.subTest(batch=parameter_name):
                batch_template = next(
                    child
                    for child in templates
                    if parameter_name in child.get("parameters", {})
                    and any(
                        resource["type"] == resource_type
                        for resource in resources(child)
                    )
                )
                resource = next(
                    resource
                    for resource in resources(batch_template)
                    if resource["type"] == resource_type
                )
                self.assertEqual(resource["copy"]["count"], f"[length(parameters('{parameter_name}'))]")

        sources = [ROOT / "infra" / "main.bicep"]
        sources.extend((ROOT / "infra" / "loadtest").glob("*.bicep"))
        for source_path in sources:
            with self.subTest(source=source_path.name):
                self.assertNotIn("dependsOn", source_path.read_text())

        source = (ROOT / "infra" / "loadtest" / "iot-factory-health-model.bicep").read_text()
        self.assertIn("range(0, min(batchSize, entityCount - batchIndex * batchSize))", source)
        self.assertIn("range(0, min(batchSize, relationshipCount - batchIndex * batchSize))", source)
        self.assertNotIn("range(0, entityCount)", source)
        self.assertNotIn("range(1, entityCount)", source)

        relationship_module = next(
            resource
            for resource in resources(load_test)
            if resource["type"] == "Microsoft.Resources/deployments"
            and "iot-factory-relationships" in resource["name"]
        )
        relationship_input = relationship_module["properties"]["parameters"]["relationships"]["copy"][0]["input"]
        self.assertIn("entityBatch[", relationship_input)
        self.assertIn(".outputs.entityNames", relationship_input)
        for batch_size in (22, 400):
            with self.subTest(batch_size=batch_size):
                entity_batch_count = (8000 + batch_size - 1) // batch_size
                relationship_batch_count = (8799 + batch_size - 1) // batch_size
                self.assertLessEqual(entity_batch_count + relationship_batch_count + 3, 800)
                self.assertLessEqual(batch_size, 400)
                if batch_size == 400:
                    self.assertEqual((entity_batch_count, relationship_batch_count), (20, 22))

        cloud_health_versions = {
            resource["apiVersion"]
            for child in templates
            for resource in resources(child)
            if resource["type"].startswith("Microsoft.CloudHealth/")
        }
        self.assertEqual(cloud_health_versions, {"2026-05-01-preview"})

    def test_C5_every_entity_uses_a_same_environment_reusable_azure_signal(self):
        template, _ = compiled_main()
        templates = list(nested_templates(template))
        signal_template = next(
            child
            for child in templates
            if any(
                resource["type"] == "Microsoft.CloudHealth/healthmodels/signaldefinitions"
                for resource in resources(child)
            )
        )
        profiles = signal_template["variables"]["profiles"]
        definitions = next(
            resource
            for resource in resources(signal_template)
            if resource["type"] == "Microsoft.CloudHealth/healthmodels/signaldefinitions"
        )

        self.assertEqual(len(profiles), 10)
        self.assertEqual(len({profile["name"] for profile in profiles}), 10)
        self.assertEqual(definitions["copy"]["count"], "[length(variables('profiles'))]")
        self.assertEqual(
            {
                profile["azureResourceId"].rsplit(".", 1)[-1].rstrip("]")
                for profile in profiles
            },
            {"containerApp", "mcpApp", "foundryAccount"},
        )
        for profile in profiles:
            with self.subTest(signal=profile["name"]):
                self.assertTrue(profile["azureResourceId"].startswith("[parameters('monitoredResources')."))
                self.assertGreaterEqual(profile["unhealthyThreshold"], profile["degradedThreshold"])

        entity_template = next(
            child
            for child in templates
            if "entities" in child.get("parameters", {})
            and "signalProfiles" in child.get("parameters", {})
            and any(
                resource["type"] == "Microsoft.CloudHealth/healthmodels/entities"
                for resource in resources(child)
            )
        )
        entity = next(
            resource
            for resource in resources(entity_template)
            if resource["type"] == "Microsoft.CloudHealth/healthmodels/entities"
        )
        self.assertEqual(entity["properties"]["signalGroups"]["azureResource"]["resourceHealth"]["enabled"], "Disabled")
        self.assertEqual(
            entity["properties"]["signalGroups"]["azureResource"]["signals"][0]["signalDefinitionName"],
            "[parameters('signalProfiles')[mod(parameters('entities')[copyIndex()].index, length(parameters('signalProfiles')))].signalDefinitionName]",
        )
        self.assertEqual(
            Counter(index % len(profiles) for index in range(8000)),
            {profile_index: 800 for profile_index in range(10)},
        )

        load_test = load_test_template(template)
        signal_module = next(
            resource
            for resource in resources(load_test)
            if resource["type"] == "Microsoft.Resources/deployments"
            and resource["name"] == "signal-definitions"
        )
        self.assertIn(
            "healthModelAccess",
            signal_module["properties"]["parameters"]["monitoredResources"]["value"],
        )
        source = (ROOT / "infra" / "loadtest" / "signal-definitions.bicep").read_text()
        for resource_key in ("containerApp", "mcpApp", "foundryAccount"):
            with self.subTest(resource=resource_key):
                self.assertIn(f"monitoredResources.{resource_key}", source)
        self.assertNotIn("/subscriptions/", source)

    def test_C7_production_graph_counts_and_warning_free_build_are_preserved(self):
        template, stderr = compiled_main()

        self.assertEqual(stderr, "")
        templates = list(nested_templates(template))
        entity_template = next(
            child
            for child in templates
            if "deterministicEntityCount" in child.get("outputs", {})
        )
        relationship_template = next(
            child
            for child in templates
            if "deterministicRelationshipCount" in child.get("outputs", {})
        )
        self.assertEqual(entity_template["outputs"]["deterministicEntityCount"]["value"], 27)
        self.assertEqual(
            len(
                [
                    resource
                    for resource in resources(entity_template)
                    if resource["type"] == "Microsoft.CloudHealth/healthmodels/entities"
                ]
            ),
            27,
        )
        self.assertEqual(relationship_template["outputs"]["deterministicRelationshipCount"]["value"], 26)
        self.assertEqual(
            len(
                [
                    resource
                    for resource in resources(relationship_template)
                    if resource["type"] == "Microsoft.CloudHealth/healthmodels/relationships"
                ]
            ),
            26,
        )


if __name__ == "__main__":
    unittest.main()
