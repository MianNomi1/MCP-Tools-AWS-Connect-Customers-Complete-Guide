# This is the common file and reads the values from the output of the stacks
import json
from pathlib import Path

OUTPUTS_FILE = Path(__file__).resolve().parent.parent / "infra" / "outputs.json"

def get_output(stack: str, key:str) -> str:
    if not OUTPUTS_FILE.exists():
        raise SystemExit(f"{OUTPUTS_FILE} not found")
    
    # IF the file was found
    outputs = json.loads(OUTPUTS_FILE.read_text())

    try:
        return outputs[stack][key]
    except KeyError:
        raise SystemExit("Output is not present")