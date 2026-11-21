import threading
import time
import uuid
from urllib.parse import quote

from azure.core.exceptions import HttpResponseError
from azure.core.rest import HttpRequest
from azure.mgmt.cloudhealth import CloudHealthMgmtClient
from azure.mgmt.resourcegraph import ResourceGraphClient
from azure.mgmt.resourcegraph.models import QueryRequest, QueryRequestOptions

import builder_signals

from config import (
    CATALOG_CACHE_SECONDS,
    CLOUDHEALTH_API_VERSION,
    GUID,
    MODEL_CACHE_SECONDS,
    MODEL_CACHE_SIZE,
    RESOURCE_GROUP_NAME,
)


MODELS_QUERY = (
    "resources"
    " | where type =~ 'microsoft.cloudhealth/healthmodels'"
    " | project id, name, location, provisioningState = tostring(properties.provisioningState)"
)
PAGE_SIZE = 1000
CLIENT_CACHE_SIZE = 32
CLIENT_CACHE_SECONDS = 600
CALLER_CACHE_SIZE = 64
UNAVAILABLE_STATUSES = (400, 403, 404)
POLL_SECONDS = 1
MONITORING_READER = "43d0d8ad-25c7-4714-9337-8ba259a9fe05"
RAW_COLLECTIONS = {
    "entities": "entities",
    "signalDefinitions": "signaldefinitions",
    "relationships": "relationships",
}
OPERATIONS = {
    "entity": "entities",
    "signalDefinition": "signal_definitions",
    "relationship": "relationships",
}


MISSING = object()


class TtlCache:
    def __init__(self, size, seconds, clock):
        self._size = size
        self._seconds = seconds
        self._clock = clock
        self._items = {}
        self._lock = threading.Lock()

    def get(self, key):
        with self._lock:
            entry = self._items.get(key)
            if entry is None:
                return MISSING
            if self._clock() >= entry[0]:
                del self._items[key]
                return MISSING
            return entry[1]

    def put(self, key, value):
        with self._lock:
            self._items.pop(key, None)
            while len(self._items) >= self._size:
                del self._items[next(iter(self._items))]
            self._items[key] = (self._clock() + self._seconds, value)


def cached(cache, key, load):
    value = cache.get(key)
    if value is MISSING:
        value = load()
        cache.put(key, value)
    return value


class HealthModels:
    def __init__(self, credentials, clock=time.monotonic):
        self.credentials = credentials
        self.clients = TtlCache(CLIENT_CACHE_SIZE, CLIENT_CACHE_SECONDS, clock)
        self.graphs = TtlCache(CLIENT_CACHE_SIZE, CLIENT_CACHE_SECONDS, clock)
        self.catalogs = TtlCache(CALLER_CACHE_SIZE, CATALOG_CACHE_SECONDS, clock)
        self.known = TtlCache(MODEL_CACHE_SIZE, MODEL_CACHE_SECONDS, clock)

    def as_user(self, caller):
        return UserModels(self, caller)


class UserModels:
    def __init__(self, shared, caller):
        self._shared = shared
        self._owner = caller.owner
        self._token = caller.fingerprint
        self._credential = shared.credentials.credential(caller)

    def client(self, subscription_id):
        return cached(
            self._shared.clients,
            (self._owner, self._token, subscription_id),
            lambda: CloudHealthMgmtClient(
                self._credential, subscription_id, api_version=CLOUDHEALTH_API_VERSION
            ),
        )

    def query_models(self):
        return cached(self._shared.catalogs, self._owner, self._query_models)

    def _query_models(self):
        return self._resource_graph(MODELS_QUERY)

    def check_workspace_access(self):
        # A successful empty query also opens a usable workspace. No resource identity leaves this check.
        self._resource_graph("resources | take 1 | project readable = 1")

    def _resource_graph(self, query, subscriptions=None):
        graph = cached(
            self._shared.graphs,
            (self._owner, self._token),
            lambda: ResourceGraphClient(self._credential),
        )
        rows = []
        skip_token = None
        while True:
            page = graph.resources(
                QueryRequest(
                    query=query,
                    subscriptions=subscriptions,
                    options=QueryRequestOptions(skip_token=skip_token, top=PAGE_SIZE),
                )
            )
            rows.extend(page.data)
            skip_token = page.skip_token
            if not skip_token:
                return rows

    def builder_groups(self):
        return self._resource_graph(
            "resourcecontainers | where type =~ 'microsoft.resources/subscriptions/resourcegroups'"
            " | project id, name, subscriptionId, location | order by name asc, id asc"
        )

    def builder_resources(self, group_id):
        parts = group_id.split("/") if isinstance(group_id, str) else []
        if (len(parts) != 5 or parts[0] or parts[1].lower() != "subscriptions"
                or parts[3].lower() != "resourcegroups" or not GUID.fullmatch(parts[2])
                or not RESOURCE_GROUP_NAME.fullmatch(parts[4])):
            raise ValueError("Select a resource group from the list.")
        resources = f"resources | where resourceGroup =~ '{parts[4]}'"
        columns = " | project id, name, type, location"
        order = " | order by name asc, id asc"
        availability = (
            " | extend targetId = tolower(id)"
            " | join kind=leftouter (healthresources | where type =~ 'microsoft.resourcehealth/availabilitystatuses'"
            " | project targetId = tolower(tostring(properties.targetResourceId)),"
            " availabilityState = tostring(properties.availabilityState)) on targetId"
        )
        try:
            return self._resource_graph(resources + availability + columns + ", availabilityState" + order, [parts[2]])
        except HttpResponseError as error:
            if error.status_code not in (400, 403):
                raise
            # Resource Health coverage is optional. Keep inventory usable when this table is unavailable.
            return self._resource_graph(resources + columns + order, [parts[2]])

    def builder_location(self, subscription_id, preferred_location):
        response = self.client(subscription_id).send_request(HttpRequest(
            "GET", f"/subscriptions/{quote(subscription_id, safe='')}/providers/Microsoft.CloudHealth",
            params={"api-version": "2021-04-01"},
        ))
        response.raise_for_status()
        for resource in response.json().get("resourceTypes", []):
            if resource["resourceType"].casefold() == "healthmodels" and resource.get("locations"):
                regions = [region.replace(" ", "").lower() for region in resource["locations"]]
                preferred = (preferred_location or "").replace(" ", "").lower()
                return preferred if preferred in regions else sorted(regions)[0]
        raise ValueError("Azure did not return a supported health model region for this subscription.")

    def check_builder_signal(self, resource):
        return builder_signals.observe(self.client(resource["id"].split("/")[2]), resource)

    def builder_parent(self, sub, group, name):
        try:
            parent = self.client(sub).health_models.get(group, name)
        except HttpResponseError as error:
            if error.status_code == 404:
                return None
            raise
        return parent.as_dict()

    def create_builder_parent(self, sub, group, name, location, tags):
        return self.client(sub).health_models.begin_create(
            group, name, {"location": location, "properties": {}, "identity": {"type": "SystemAssigned"}, "tags": tags},
            headers={"If-None-Match": "*"}, polling_interval=POLL_SECONDS,
        ).result().as_dict()

    def ensure_builder_auth(self, sub, group, name):
        settings = self.client(sub).authentication_settings
        try:
            current = settings.get(group, name, "auth-system")
        except HttpResponseError as error:
            if error.status_code != 404:
                raise
        else:
            props = current.as_dict()["properties"]
            if props.get("authenticationKind") == "ManagedIdentity" and props.get("managedIdentityName") == "SystemAssigned":
                return
            raise ValueError("The auth-system setting changed. Check the model in Azure.")
        settings.begin_create_or_update(
            group, name, "auth-system",
            {"properties": {"displayName": "Health model system identity",
                            "authenticationKind": "ManagedIdentity", "managedIdentityName": "SystemAssigned"}},
            polling_interval=POLL_SECONDS,
        ).result()

    def grant_monitoring_reader(self, subscription, principal, scope):
        """Use this caller's ARM credential for one resource and one built-in role."""
        prefix = f"/subscriptions/{subscription}/resourceGroups/"
        if not GUID.fullmatch(principal) or not scope.casefold().startswith(prefix.casefold()) or "/providers/" not in scope.casefold():
            raise ValueError("The model identity or monitored resource is invalid.")
        client = self.client(subscription)
        role = f"/subscriptions/{subscription}/providers/Microsoft.Authorization/roleDefinitions/{MONITORING_READER}"
        base = quote(scope, safe="/") + "/providers/Microsoft.Authorization/roleAssignments"
        version = {"api-version": "2022-04-01"}

        def existing():
            assignments = self._list_raw(client, base, {**version, "$filter": f"principalId eq '{principal}'"})
            for item in assignments:
                props = item["properties"]
                assigned = props["scope"].rstrip("/").casefold()
                if (props["principalId"].casefold() == principal.casefold()
                        and props["roleDefinitionId"].rsplit("/", 1)[-1].lower() == MONITORING_READER
                        and (scope.casefold() + "/").startswith(assigned + "/") and not props.get("condition")):
                    return item["id"]
            return None

        if assignment := existing():
            return assignment
        name = uuid.uuid5(uuid.NAMESPACE_URL, f"{scope}/{principal}/{MONITORING_READER}".casefold())
        request = HttpRequest("PUT", f"{base}/{name}", params=version, json={"properties": {
            "roleDefinitionId": role, "principalId": principal, "principalType": "ServicePrincipal",
        }})
        response = client.send_request(request)
        if response.status_code == 409 and (assignment := existing()):
            return assignment
        response.raise_for_status()
        return response.json()["id"]

    def remember_builder_model(self, target):
        # Resource Graph indexes asynchronously. A successful ARM read lets the creator open the model immediately.
        sub, group, name = (target[k] for k in ("subscriptionId", "resourceGroup", "name"))
        model_id = f"/subscriptions/{sub}/resourceGroups/{group}/providers/Microsoft.CloudHealth/healthmodels/{name}"
        try:
            rows = self.query_models()
        except HttpResponseError:
            rows = []
        rows = [row for row in rows if row.get("id", "").casefold() != model_id.casefold()]
        rows.append({"id": model_id, "name": name, "location": target["location"], "provisioningState": "Succeeded"})
        self._shared.catalogs.put(self._owner, rows)
        self._shared.known.put((self._owner, sub.casefold(), group.casefold(), name.casefold()), True)

    def has_model(self, subscription_id, resource_group, model_name):
        key = (self._owner, *(part.casefold() for part in (subscription_id, resource_group, model_name)))
        return cached(
            self._shared.known, key, lambda: self._probe(subscription_id, resource_group, model_name)
        )

    def _probe(self, subscription_id, resource_group, model_name):
        try:
            self.client(subscription_id).health_models.get(resource_group, model_name)
        except HttpResponseError as error:
            if error.status_code in UNAVAILABLE_STATUSES:
                return False
            raise
        return True

    def _list_raw(self, client, url, params=None):
        items = []
        request = HttpRequest("GET", url, params=params or {"api-version": CLOUDHEALTH_API_VERSION})
        while request:
            response = client.send_request(request)
            response.raise_for_status()
            body = response.json()
            items += body.get("value") or []
            next_link = body.get("nextLink")
            request = HttpRequest("GET", next_link) if next_link else None
        return items

    def read_model(self, subscription_id, resource_group, model_name):
        client = self.client(subscription_id)
        base = (
            f"/subscriptions/{quote(subscription_id, safe='')}"
            f"/resourceGroups/{quote(resource_group, safe='')}"
            f"/providers/Microsoft.CloudHealth/healthmodels/{quote(model_name, safe='')}"
        )
        return {
            name: self._list_raw(client, f"{base}/{path}")
            for name, path in RAW_COLLECTIONS.items()
        }

    def write_resource(self, subscription_id, resource_group, model_name, kind, name, properties):
        operations = getattr(self.client(subscription_id), OPERATIONS[kind])
        operations.begin_create_or_update(
            resource_group,
            model_name,
            name,
            {"properties": properties},
            polling_interval=POLL_SECONDS,
        ).result()

    def delete_resource(self, subscription_id, resource_group, model_name, kind, name):
        operations = getattr(self.client(subscription_id), OPERATIONS[kind])
        operations.begin_delete(
            resource_group, model_name, name, polling_interval=POLL_SECONDS
        ).result()
