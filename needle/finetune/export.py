"""Export the original checkpoint, optionally merging a local LoRA adapter.

No network requests: use the pinned base archive's tokenizer. Explicitly export
4-bit weights even without an adapter (upstream's CLI copies the 2-bit archive).
"""
import argparse
import json

import jax
import jax.numpy as jnp
from needle.model.architecture import effective_kv_window
from needle.model.checkpoints import read_adapter
from needle.model.export import read_tokenizer_blob, write_export
from needle.model.finetune import merge_lora, rung
from needle.model.run import load_checkpoint

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--checkpoint", required=True)
parser.add_argument("--base-archive", required=True)
parser.add_argument("--adapter")
parser.add_argument("--output", required=True)
args = parser.parse_args()
params, config = load_checkpoint(args.checkpoint)
if args.adapter:
    # Training converts the frozen checkpoint to float32. Merge at the same
    # precision: rounding LoRA deltas to the checkpoint's float16 beforehand
    # can move weights across CQ bucket boundaries.
    params = jax.tree.map(lambda value: jnp.asarray(value, dtype=jnp.float32), params)
    adapter = read_adapter(args.adapter)
    lora = {tuple(key.split("/")): {name: jnp.asarray(value) for name, value in matrices.items()}
            for key, matrices in adapter["lora"].items()}
    params = merge_lora(params, lora, adapter["scale"])
params, config = rung(params, config, config.num_layers)
result = write_export(params, config, args.output, bits=4,
                      tokenizer=read_tokenizer_blob(args.base_archive),
                      kv_window=effective_kv_window(config))
print(json.dumps({**result, "layers": config.num_layers, "weight_bits": 4}, indent=2))
