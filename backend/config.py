from pydantic import Field
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # 0G Storage / chain
    zg_private_key: str = ""
    zg_storage_node_url: str = "https://indexer-storage-testnet-turbo.0g.ai"
    zg_rpc_url: str = "https://evmrpc-testnet.0g.ai"

    # Task queue / job-state store. The API only ever talks to Redis — never to the
    # worker or to 0G Compute directly. The worker (separate process) reads the same Redis.
    # validation_alias bypasses the ZG_ prefix so the env var is plain REDIS_URL.
    redis_url: str = Field(default="redis://localhost:6379/0", validation_alias="REDIS_URL")

    # 0G Compute inference Router (worker-only — the API never calls this).
    # OpenAI-compatible endpoint; billed via API key from pc.0g.ai. There is NO
    # `compute.0g.ai/jobs` REST API — that shape was fictional and has been removed.
    zg_compute_router_url: str = "https://router-api.0g.ai/v1"
    zg_compute_api_key: str = ""
    zg_compute_model: str = "minimax-m3"  # FREE + TEE-attested; paid models need mainnet funds

    # NO env_prefix: field names already include the zg_ prefix, so they map directly to
    # ZG_PRIVATE_KEY, ZG_RPC_URL, etc. Adding env_prefix="ZG_" would (wrongly) look for
    # ZG_ZG_PRIVATE_KEY and silently fall back to defaults. redis_url uses its own alias.
    model_config = {"env_file": ".env", "extra": "ignore"}


settings = Settings()
