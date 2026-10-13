import io
import json
import pathlib
import re
import sys
import zipfile

SENSITIVE = {'authorization', 'cookie', 'set-cookie', 'csrf_token', 'csrftoken', 'access_token', 'refresh_token', 'session_token', 'password', 'x-carr-csrf', '__host-dealroom_session', '__host-tour_share_session', 'csrftokenhash', 'token', 'share_token'}

def clean(value):
    if isinstance(value, dict):
        if str(value.get('name', '')).lower() in SENSITIVE:
            return {**value, 'value': '[redacted]'}
        return {key: '[redacted]' if key.lower() in SENSITIVE else clean(item) for key, item in value.items()}
    if isinstance(value, list):
        return [clean(item) for item in value]
    if isinstance(value, str):
        try:
            nested = json.loads(value)
            if isinstance(nested, (dict, list)):
                return json.dumps(clean(nested))
        except ValueError:
            pass
        value = re.sub(r'(__Host-(?:dealroom_session|tour_share_session)=)[A-Za-z0-9_-]+', r'\1[redacted]', value)
        value = re.sub(r'(?i)([?#&](?:token|share_token)=)[^&\s"<>]+', r'\1[redacted]', value)
        value = re.sub(r'(?<![\w-])[A-Za-z0-9_-]{43}(?![\w-])', '[redacted]', value)
        return re.sub(r'(?i)(Bearer\s+)[A-Za-z0-9._~-]+', r'\1[redacted]', value)
    return value

def scrub_text(data):
    text = data.decode('utf8')
    try:
        return json.dumps(clean(json.loads(text))).encode()
    except ValueError:
        lines = []
        for line in text.splitlines():
            try:
                lines.append(json.dumps(clean(json.loads(line))))
            except ValueError:
                line = re.sub(r'(?i)("(?:csrf_token|csrfToken|authorization|cookie|set-cookie)"\s*:\s*")[^"\n]*', r'\1[redacted]', line)
                lines.append(clean(line))
        return ('\n'.join(lines) + '\n').encode()

def scrub_bytes(name, data):
    if name.endswith('.zip'):
        source = zipfile.ZipFile(io.BytesIO(data))
        output = io.BytesIO()
        with source, zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as dest:
            for item in source.infolist():
                body = source.read(item)
                if not item.is_dir():
                    body = scrub_bytes(item.filename, body)
                dest.writestr(item, body)
        return output.getvalue()
    if any(name.endswith(ext) for ext in ('.png', '.jpg', '.jpeg', '.webm', '.mp4', '.woff', '.woff2')):
        return data
    try:
        return scrub_text(data)
    except UnicodeError:
        return data

if __name__ == '__main__':
    root = pathlib.Path(sys.argv[1])
    for path in root.rglob('*'):
        if path.is_file():
            path.write_bytes(scrub_bytes(path.name, path.read_bytes()))
    print('Evidence credential fields scrubbed')
