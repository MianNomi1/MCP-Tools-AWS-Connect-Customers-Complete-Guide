"""Load data/*.json into the DynamoDB tables created by the Tools stack."""
import json
from decimal import Decimal
from pathlib import Path

import boto3

from outputs import get_output

STACK = "HorizonBankMCPTools-MCP-Tools-banking"
DATA_DIR = Path(__file__).resolve().parent.parent / "data"


def load(file_name: str) -> list:
    # parse_float=Decimal because DynamoDB does not accept Python floats.
    return json.loads((DATA_DIR / file_name).read_text(), parse_float=Decimal)


def seed(table_name: str, items: list) -> None:
    table = boto3.resource("dynamodb").Table(table_name)
    with table.batch_writer() as batch:
        for item in items:
            batch.put_item(Item=item)
    print(f"Wrote {len(items)} items to {table_name}")


def main() -> None:
    seed(get_output(STACK, "BranchesTableName"), load("branches.json"))
    seed(get_output(STACK, "LoanProductsTableName"), load("loan_products.json"))


if __name__ == "__main__":
    main()