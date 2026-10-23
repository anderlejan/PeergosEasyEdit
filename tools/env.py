"""Loads settings for the build and test tools from environment variables, with a `.env` file in the repository root
as a local fallback (KEY=value lines; `#` comments; values already set in the environment win).
See `.env.example` for every setting. The app itself has no settings or secrets: it runs inside Peergos."""
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

DEFAULTS = {
    'MOCK_PORT': '8791',
    'PEERGOS_JAR': os.path.join(ROOT, '_local', 'peergos', 'Peergos.jar'),
    'PEERGOS_URL': 'http://localhost:8777',
    'PEERGOS_TEST_USER': 'testuser',
    'PEERGOS_TEST_PASSWORD': '',
    'RELEASE_OUT': os.path.join(ROOT, 'Releases'),
}


def load(path=None):
    path = path or os.path.join(ROOT, '.env')
    if os.path.isfile(path):
        with open(path, encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                k, v = line.split('=', 1)
                k, v = k.strip(), v.strip()
                if len(v) >= 2 and v[0] == v[-1] and v[0] in '"\'':
                    v = v[1:-1]
                os.environ.setdefault(k, v)
    for k, v in DEFAULTS.items():
        os.environ.setdefault(k, v)
    return os.environ


def get(key):
    load()
    return os.environ.get(key, '')
