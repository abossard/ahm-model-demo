import os

import psycopg
import uvicorn

from src.survey.app.main import create_app
from src.survey.app.storage import Storage


if __name__ == "__main__":
    dsn = os.environ["SURVEY_TEST_DSN"]
    if psycopg.conninfo.conninfo_to_dict(dsn).get("host") != "127.0.0.1":
        raise RuntimeError("The browser test fixture accepts only an explicit local disposable database.")
    uvicorn.run(create_app(Storage(lambda: psycopg.connect(dsn))),
                host="127.0.0.1", port=4174, access_log=False)
