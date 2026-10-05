from dataclasses import dataclass
import os

import psycopg
from azure.identity import DefaultAzureCredential


@dataclass(frozen=True)
class Config:
    host: str
    database: str
    user: str
    client_id: str
    insights: str

    @classmethod
    def load(cls):
        names = ("POSTGRES_HOST", "POSTGRES_DATABASE", "POSTGRES_USER",
                 "AZURE_CLIENT_ID", "APPLICATIONINSIGHTS_CONNECTION_STRING")
        missing = [name for name in names if not os.environ.get(name)]
        if missing:
            raise RuntimeError("Missing survey configuration: " + ", ".join(missing))
        if os.environ.get("OTEL_SERVICE_NAME") != "ahm-survey":
            raise RuntimeError("OTEL_SERVICE_NAME must be ahm-survey")
        return cls(*(os.environ[name] for name in names))

    def connection_factory(self):
        credential = DefaultAzureCredential(managed_identity_client_id=self.client_id)

        def connect():
            token = credential.get_token("https://ossrdbms-aad.database.windows.net/.default")
            return psycopg.connect(host=self.host, dbname=self.database, user=self.user,
                                   password=token.token, sslmode="require", connect_timeout=8)

        return connect, credential
