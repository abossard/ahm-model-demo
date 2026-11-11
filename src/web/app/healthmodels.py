import threading
import time
from urllib.parse import quote

from azure.core.exceptions import HttpResponseError
from azure.core.rest import HttpRequest
from azure.mgmt.cloudhealth import CloudHealthMgmtClient
from azure.mgmt.resourcegraph import ResourceGraphClient
from azure.mgmt.resourcegraph.models import QueryRequest, QueryRequestOptions

from config import (
    CATALOG_CACHE_SECONDS,
    CLOUDHEALTH_API_VERSION,
    MODEL_CACHE_SECONDS,
    MODEL_CACHE_SIZE,
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
                    query=MODELS_QUERY,
                    options=QueryRequestOptions(skip_token=skip_token, top=PAGE_SIZE),
                )
            )
            rows.extend(page.data)
            skip_token = page.skip_token
            if not skip_token:
                return rows

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

    def _list_raw(self, client, url):
        items = []
        request = HttpRequest("GET", url, params={"api-version": CLOUDHEALTH_API_VERSION})
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
