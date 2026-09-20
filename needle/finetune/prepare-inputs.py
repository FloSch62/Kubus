"""Fetch and verify the public checkpoint/tokenizer used for this training run."""
import hashlib
from pathlib import Path
import urllib.request

from needle.model import tokenizer

REVISION = "b274efcb211a9eef48c9a88da4b43bd569696a39"
BASE = f"https://huggingface.co/Cactus-Compute/needle3/resolve/{REVISION}/"
ROOT = Path(__file__).resolve().parents[2] / ".cache" / "needle-training"
FILES = [
    ("checkpoints/needle3.safetensors", ROOT / "needle3.safetensors", "c234c70dccc7a9115e7c41ac2e41d3655fea3b85c245dd898b46179fb90c6c0c"),
    ("tokenizer/tokenizer.model", Path(tokenizer.TOKENIZER_PREFIX + ".model"), "97dfd5666620b19875deba9e55953d312364e7763bd08bee428b94f1b9491b25"),
    ("tokenizer/tokenizer.vocab", Path(tokenizer.TOKENIZER_PREFIX + ".vocab"), "7c87aa0da9f19b5d5a97824ec94555d6e73766f2a60e51e7ebe0b7c61ded3b33"),
]
for source, target, expected in FILES:
    if target.exists() and hashlib.sha256(target.read_bytes()).hexdigest() == expected:
        print(f"verified {target.name}")
        continue
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(target.suffix + ".download")
    try:
        urllib.request.urlretrieve(BASE + source, temporary)
        if hashlib.sha256(temporary.read_bytes()).hexdigest() != expected:
            raise RuntimeError(f"SHA-256 mismatch for {source}")
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)
    print(f"downloaded and verified {target.name}")
