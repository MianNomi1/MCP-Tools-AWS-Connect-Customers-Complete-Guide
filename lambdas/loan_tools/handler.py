"""Loan tools exposed through AgentCore Gateway.

Tools:
  list_loan_products                     -> products and their current rules
  check_loan_eligibility(...)            -> indicative eligibility (deterministic)
  calculate_emi(principal, rate, months) -> monthly repayment estimate
"""
import json
import logging
import math
import os
from decimal import Decimal

import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

TABLE = boto3.resource("dynamodb").Table(os.environ["LOAN_PRODUCTS_TABLE"])
DISCLAIMER = (
    "This is an indicative result only, not a loan offer. Final approval requires a full "
    "application, a credit check and income verification."
)


# ---------- helpers ----------
def _to_native(value):
    if isinstance(value, list):
        return [_to_native(v) for v in value]
    if isinstance(value, dict):
        return {k: _to_native(v) for k, v in value.items()}
    if isinstance(value, Decimal):
        return int(value) if value % 1 == 0 else float(value)
    return value


def _tool_name(context) -> str:
    return context.client_context.custom["bedrockAgentCoreToolName"].split("___", 1)[-1]


def _number(event: dict, key: str, required: bool = True, minimum: float = 0.0):
    raw = event.get(key)
    if raw is None or raw == "":
        if required:
            raise ValueError(f"Parameter '{key}' is required.")
        return None
    try:
        value = float(raw)
    except (TypeError, ValueError):
        raise ValueError(f"Parameter '{key}' must be a number.")
    if math.isnan(value) or value < minimum:
        raise ValueError(f"Parameter '{key}' must be at least {minimum}.")
    return value


def _get_product(product_type) -> dict:
    if not isinstance(product_type, str) or not product_type.strip():
        raise ValueError("Parameter 'product_type' is required (personal, car or home).")
    item = TABLE.get_item(Key={"product_type": product_type.strip().lower()}).get("Item")
    if not item:
        raise ValueError(f"Unknown product_type '{product_type}'. Use personal, car or home.")
    return _to_native(item)


def _emi(principal: float, annual_rate_pct: float, months: int) -> float:
    """Standard amortised monthly payment: P * r * (1+r)^n / ((1+r)^n - 1)."""
    r = annual_rate_pct / 100 / 12
    if r == 0:
        return principal / months
    growth = (1 + r) ** months
    return principal * r * growth / (growth - 1)


def _principal_for_emi(emi: float, annual_rate_pct: float, months: int) -> float:
    """Inverse of _emi: the largest principal a given monthly payment can repay."""
    r = annual_rate_pct / 100 / 12
    if r == 0:
        return emi * months
    growth = (1 + r) ** months
    return emi * (growth - 1) / (r * growth)


# ---------- tools ----------
def list_loan_products(_event: dict) -> dict:
    items = _to_native(TABLE.scan().get("Items", []))
    return {"products": sorted(items, key=lambda p: p["product_type"])}


def check_loan_eligibility(event: dict) -> dict:
    product = _get_product(event.get("product_type"))
    salary = _number(event, "monthly_salary", minimum=0.01)
    existing_debt = _number(event, "existing_monthly_debt", required=False) or 0.0
    requested = _number(event, "requested_amount", required=False, minimum=1)
    tenure = _number(event, "tenure_months", required=False, minimum=1)

    tenure = int(min(tenure or product["max_tenure_months"], product["max_tenure_months"]))
    tenure = max(tenure, product["min_tenure_months"])
    rate = product["annual_interest_rate"]

    reasons = []
    max_total_debt_payment = salary * product["max_dti_ratio"]
    affordable_emi = max_total_debt_payment - existing_debt

    if salary < product["min_monthly_salary"]:
        reasons.append(
            f"Monthly salary is below the minimum of {product['min_monthly_salary']} {product['currency']} for this product."
        )
    if affordable_emi <= 0:
        reasons.append("Existing monthly debt already uses the full allowed debt-to-income ratio.")

    max_by_affordability = _principal_for_emi(max(affordable_emi, 0), rate, tenure)
    max_by_income_multiple = salary * product["max_salary_multiple"]
    max_eligible = min(max_by_affordability, max_by_income_multiple, product["max_amount"])
    max_eligible = math.floor(max_eligible / 100) * 100  # round down to the nearest 100

    if not reasons and max_eligible < product["min_amount"]:
        reasons.append(f"The affordable amount is below the product minimum of {product['min_amount']}.")
    if not reasons and requested is not None and requested > max_eligible:
        reasons.append(f"The requested amount is above the indicative maximum of {max_eligible}.")

    eligible = not reasons
    meets_basic_rules = salary >= product["min_monthly_salary"] and affordable_emi > 0
    result = {
        "product": product["display_name"],
        "currency": product["currency"],
        "eligible": eligible,
        "reasons": reasons,
        "inputs_used": {
            "monthly_salary": salary,
            "existing_monthly_debt": existing_debt,
            "requested_amount": requested,
            "tenure_months": tenure,
        },
        "rules_applied": {
            "min_monthly_salary": product["min_monthly_salary"],
            "max_dti_ratio": product["max_dti_ratio"],
            "max_salary_multiple": product["max_salary_multiple"],
            "annual_interest_rate": rate,
        },
        # The most the customer could borrow under the rules (0 if basic rules fail).
        "indicative_max_amount": max(max_eligible, 0) if meets_basic_rules else 0,
        "disclaimer": DISCLAIMER,
    }
    if eligible and requested is not None:
        result["estimated_monthly_payment"] = round(_emi(requested, rate, tenure), 2)
    elif eligible:
        result["estimated_monthly_payment_at_max"] = round(_emi(max_eligible, rate, tenure), 2)
    return result


def calculate_emi(event: dict) -> dict:
    principal = _number(event, "principal", minimum=1)
    rate = _number(event, "annual_interest_rate", minimum=0)
    months = int(_number(event, "tenure_months", minimum=1))
    if months > 480:
        raise ValueError("Parameter 'tenure_months' must be 480 or less.")
    emi = _emi(principal, rate, months)
    return {
        "principal": principal,
        "annual_interest_rate": rate,
        "tenure_months": months,
        "monthly_payment": round(emi, 2),
        "total_repayment": round(emi * months, 2),
        "total_interest": round(emi * months - principal, 2),
    }


TOOLS = {
    "list_loan_products": list_loan_products,
    "check_loan_eligibility": check_loan_eligibility,
    "calculate_emi": calculate_emi,
}


def lambda_handler(event, context):
    tool = _tool_name(context)
    # Do not log salary values in production; they are personal financial data.
    logger.info(json.dumps({"tool": tool, "argument_keys": sorted((event or {}).keys())}))
    handler = TOOLS.get(tool)
    if handler is None:
        return {"error": f"Unknown tool '{tool}'"}
    try:
        return _to_native(handler(event or {}))
    except ValueError as exc:
        return {"error": str(exc)}
    except Exception:
        logger.exception("Tool %s failed", tool)
        return {"error": "Internal error while processing the request."}