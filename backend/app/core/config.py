import os
from dataclasses import dataclass, field
from pathlib import Path

def _load_env_file() -> None:
    candidates = [
        Path(__file__).resolve().parents[2] / ".env",
        Path.cwd() / ".env",
        Path.cwd() / "backend" / ".env"
    ]
    for env_file in candidates:
        if env_file.is_file():
            for line in env_file.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, val = line.split("=", 1)
                    os.environ.setdefault(key.strip(), val.strip())
            break

_load_env_file()

@dataclass
class Config:
    data_dir: Path = field(default_factory=lambda: Path(os.getenv("CLIMATELENS_DATA_DIR", str(Path(__file__).resolve().parents[3] / "data" / "processed"))).resolve())
    analytics_module: str | None = field(default_factory=lambda: os.getenv("CLIMATELENS_ANALYTICS_MODULE", "app.services.nielytics_adapter") or None)
    cors_origins: list[str] = field(default_factory=lambda: [origin.strip() for origin in os.getenv("CLIMATELENS_CORS_ORIGINS", "http://127.0.0.1:5173,http://localhost:5173").split(",") if origin.strip()])
    groq_api_key: str | None = field(default_factory=lambda: os.getenv("GROQ_API_KEY") or None)
    mistral_api_key: str | None = field(default_factory=lambda: os.getenv("MISTRAL_API_KEY") or None)
    weather_api_key: str | None = field(default_factory=lambda: os.getenv("WEATHER_API_KEY") or None)
    prediction_api_key: str | None = field(default_factory=lambda: os.getenv("PREDICTION_API_KEY") or None)
