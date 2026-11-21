import unittest
from datetime import datetime
from urllib.parse import parse_qs, urlparse

from test_healthmodels import GROUP, SUB, Harness


class PlanSignalTests(unittest.TestCase):
    def test_signal_preview_uses_one_actual_series_and_tells_the_user_when_azure_has_no_reading(self):
        scope = f"/subscriptions/{SUB}/resourceGroups/{GROUP}/providers/Microsoft.App/containerApps/demo"
        resource = {"id": scope, "type": "Microsoft.App/containerApps", "name": "demo"}
        definition = {"name": {"value": "CpuPercentage"}, "namespace": resource["type"],
                      "primaryAggregationType": "Average"}
        for case, status in [("zero", "verified"), ("forbidden", "unavailable"), ("empty", "no_data"),
                             ("dimensions", "no_data"), ("changed grain", "unavailable")]:
            with self.subTest(case=case):
                def respond(req):
                    url = urlparse(req.url)
                    self.assertTrue(url.path.startswith(scope + "/providers/Microsoft.Insights/"))
                    headers = {"Content-Type": "application/json"}
                    if url.path.endswith("metricDefinitions"):
                        return (403, headers, {}) if case == "forbidden" else (200, headers, {"value": [definition]})
                    query = parse_qs(url.query)
                    start, end = map(datetime.fromisoformat, query["timespan"][0].split("/"))
                    self.assertEqual((end - start).days, 1)
                    self.assertIsNotNone(end.tzinfo)
                    data = [] if case == "empty" else [{"timeStamp": "2026-11-19T11:00:00Z", "average": 0}]
                    stream = {"data": data, "metadatavalues": [{"name": "replica"}] if case == "dimensions" else []}
                    return 200, headers, {"interval": "PT1H" if case == "changed grain" else "PT5M",
                                          "value": [{"name": definition["name"], "unit": "Percent", "timeseries": [stream]}]}
                harness = Harness(respond)
                try:
                    result = harness.models.check_builder_signal(resource)
                    self.assertEqual(result["status"], status)
                    if case == "zero":
                        self.assertEqual((result["observation"]["sample"], result["observation"]["count"]), (0, 1))
                        self.assertEqual(result["observation"]["unit"], "Percent")
                    else:
                        self.assertNotIn("observation", result)
                finally:
                    harness.stop()

    def test_queries_the_published_catalog_until_a_resource_wide_measurement_is_found(self):
        cases = [
            ("Microsoft.App/managedEnvironments", ["IngressUsageBytes", "IngressCpuPercentage"], "IngressCpuPercentage"),
            ("Microsoft.CloudHealth/healthmodels", ["EntityCount", "DiscoveryRuleExecutionDuration"], "DiscoveryRuleExecutionDuration"),
            ("Microsoft.Example/widgets", [f"ServiceGauge{i}" for i in range(23)], "ServiceGauge22"),
        ]
        for resource_type, names, expected in cases:
            for reject_batch in [False, True]:
                with self.subTest(type=resource_type, reject_batch=reject_batch):
                    resource = {"id": f"/subscriptions/{SUB}/resourceGroups/{GROUP}/providers/{resource_type}/demo",
                                "type": resource_type, "name": "demo"}
                    calls = []
                    def respond(req):
                        url = urlparse(req.url)
                        headers = {"Content-Type": "application/json"}
                        if url.path.endswith("metricDefinitions"):
                            return 200, headers, {"value": [{"name": {"value": name}, "primaryAggregationType": "Average",
                                                             "namespace": resource_type} for name in names]}
                        query = parse_qs(url.query)
                        requested = query["metricnames"][0].split(",")
                        calls.append(requested)
                        self.assertEqual(query["metricnamespace"], [resource_type])
                        self.assertEqual(query["aggregation"], ["Average"])
                        self.assertEqual(query["interval"], ["PT5M"])
                        self.assertLessEqual(len(requested), 20)
                        if reject_batch and (len(requested) > 1 or requested == [names[0]]):
                            return 400, headers, {}
                        # Azure need not return metrics in the order requested.
                        return 200, headers, {"interval": "PT5M", "value": [
                            {"name": {"value": name}, "timeseries": [{"data": [
                                {"timeStamp": "2026-11-19T11:00:00Z", "average": 0}]}] if name == expected else []}
                            for name in reversed(requested)]}
                    harness = Harness(respond)
                    try:
                        check = harness.models.check_builder_signal(resource)
                        self.assertEqual(check["status"], "verified")
                        self.assertEqual(check["observation"]["metricName"], expected)
                        self.assertEqual(check["observation"]["sample"], 0)
                        self.assertIn(f"Azure lists {len(names)} platform metrics", check["detail"])
                        self.assertEqual(set(sum(calls, [])), set(names))
                    finally:
                        harness.stop()

    def test_reports_why_a_check_has_no_observation(self):
        for case, status, message in [
            ("empty catalog", "no_data", "no platform metric definitions"),
            ("requires dimensions", "unsupported", "dimension-free numeric check"),
            ("rejected", "unavailable", "did not return the requested five-minute series"),
            ("empty series", "no_data", "None returned a dimension-free numeric reading"),
        ]:
            with self.subTest(case=case):
                def respond(req):
                    headers = {"Content-Type": "application/json"}
                    if "metricDefinitions" in req.url:
                        return 200, headers, {"value": [] if case == "empty catalog" else [
                            {"name": {"value": "ServiceGauge"}, "primaryAggregationType": "Average",
                             "isDimensionRequired": case == "requires dimensions"}]}
                    self.assertIn(case, ("rejected", "empty series"))
                    return 200, headers, {"interval": "PT5M", "value": [
                        {"name": {"value": "ServiceGauge"}, "timeseries": [],
                         "errorCode": "BadRequest" if case == "rejected" else "Success"}]}
                harness = Harness(respond)
                try:
                    check = harness.models.check_builder_signal({
                        "id": f"/subscriptions/{SUB}/resourceGroups/{GROUP}/providers/Microsoft.Example/widgets/demo",
                        "type": "Microsoft.Example/widgets"})
                    self.assertEqual(check["status"], status)
                    self.assertIn(message, check["detail"])
                    self.assertNotIn("observation", check)
                finally:
                    harness.stop()
