import html


def as_html(result):
    request_id = html.escape(result["request_id"])
    message_id = html.escape(result["just_enqueued"]["message_id"])
    queue_head = result["queue_head"]
    head_id = html.escape(queue_head["request_id"] if queue_head else "none")
    head_label = html.escape(
        queue_head["label"] if queue_head else "oldest visible / best-effort FIFO"
    )
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Azure Health Model Demo — request journey</title>
<link rel="stylesheet" href="/static/app.css"></head>
<body><main class="legacy-result">
<h1>Movie request journey</h1>
<section><small>Correlated request</small><code>{request_id}</code></section>
<section><small>Just enqueued for this request</small><code>{message_id}</code></section>
<section><small>Queue head — {head_label}</small><code>{head_id}</code></section>
<section><small>PostgreSQL rows</small><strong>{result["row_count"]}</strong></section>
</main></body></html>"""
