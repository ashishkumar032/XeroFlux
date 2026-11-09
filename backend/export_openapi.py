"""Generate the shared contract from the application, never hand-edit it."""
from pathlib import Path
import yaml
from app.main import app

if __name__ == '__main__':
    target = Path(__file__).resolve().parents[1] / 'contracts' / 'openapi.yaml'
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(yaml.safe_dump(app.openapi(), sort_keys=False, allow_unicode=True), encoding='utf-8')
    print(f'Exported {len(app.openapi()["paths"])} paths to {target}')
