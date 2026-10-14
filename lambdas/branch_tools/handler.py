# This is our branch tool
# Expose through the Agentcore Gateway

import json
import logging
import os
from datetime import datetime, timezone
from decimal import Decimal
from zoneinfo import ZoneInfo
import boto3

from boto3.dynamodb.conditions import Key

logger = logging.getLogger()
logger.setLevel(logging.INFO)

TABLE = boto3.resource("dynamodb").Table(os.environ["BRANCHES_TABLE"])
WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
MAX_CITY_LENGTH = 60

# ---------- helpers ----------

def _to_native(value):
    """DynamoDB returns numbers as Decimal; convert for JSON."""
    if isinstance(value, list):
        return [_to_native(v) for v in value]
    if isinstance(value, dict):
        return {k: _to_native(v) for k, v in value.items()}
    if isinstance(value, Decimal):
        return int(value) if value % 1 == 0 else float(value)
    return value


def _tool_name(context) -> str:
    full_name = context.client_context.custom["bedrockAgentCoreToolName"]
    return full_name.split("___", 1)[-1]

def _normalise_city(city) -> str:
    if not isinstance(city, str) or not city.strip():
        raise ValueError("Parameter 'city' is required.")
    city = " ".join(city.strip().lower().split())
    if len(city) > MAX_CITY_LENGTH:
        raise ValueError("Parameter 'city' is too long.")
    return city


def _branches_in_city(city: str) -> list:
    response = TABLE.query(KeyConditionExpression=Key("city").eq(city))
    return response.get("Items", [])


def _open_status(branch: dict, now_utc: datetime) -> dict:
    local_now = now_utc.astimezone(ZoneInfo(branch["timezone"]))
    weekday = WEEKDAYS[local_now.weekday()]
    today_hours = branch.get("opening_hours", {}).get(weekday)
    result = {
        "local_time": local_now.strftime("%A %H:%M"),
        "timezone": branch["timezone"],
        "todays_hours": today_hours or "closed",
    }

    if branch.get("status") != "ACTIVE":
        return {**result, "open_now": False, "reason": branch.get("status_note", "Branch is temporarily closed.")}
    if local_now.strftime("%Y-%m-%d") in branch.get("closed_dates", []):
        return {**result, "open_now": False, "reason": "Closed today for a public holiday."}
    if not today_hours:
        return {**result, "open_now": False, "reason": f"Closed on {weekday.capitalize()}s."}

    opens, closes = today_hours.split("-")
    current = local_now.strftime("%H:%M")  # zero-padded HH:MM strings compare correctly
    if opens <= current < closes:
        return {**result, "open_now": True, "reason": f"Open now until {closes} local time."}
    if current < opens:
        return {**result, "open_now": False, "reason": f"Not open yet. Opens today at {opens} local time."}
    return {**result, "open_now": False, "reason": f"Closed for today. Hours were {today_hours} local time."}


def _not_found(city: str) -> dict:
    return {
        "found": False,
        "city": city,
        "message": "No Horizon Bank branch in this city. Use list_branch_cities to see available cities.",
    }


# Tools that will be called

def list_branch_cities(_event: dict) -> dict:
    items = TABLE.scan(ProjectionExpression="city, branch_name").get("Items", [])
    cities = sorted({item["city"].title() for item in items})
    return {"cities": cities, "count": len(cities)}

def get_branch_status(event: dict) -> dict:
    city = _normalise_city(event.get("city"))
    branches = _branches_in_city(city)
    if not branches:
        return _not_found(city)
    now_utc = datetime.now(timezone.utc)
    return {
        "found": True,
        "city": city.title(),
        "branches": [
            {
                "branch_id": b["branch_id"],
                "branch_name": b["branch_name"],
                "address": b["address"],
                "status": b["status"],
                **_open_status(b, now_utc),
                "weekly_hours": b.get("opening_hours", {}),
                "services": b.get("services", []),
            }
            for b in branches
        ],
    }


def get_branch_representatives(event: dict) -> dict:
    city = _normalise_city(event.get("city"))
    branches = _branches_in_city(city)
    if not branches:
        return _not_found(city)
    result = []
    for b in branches:
        reps = _to_native(b.get("representatives", {}))
        result.append({
            "branch_id": b["branch_id"],
            "branch_name": b["branch_name"],
            "status": b["status"],
            "representatives": reps,
            "total_representatives": sum(reps.values()),
        })
    return {"found": True, "city": city.title(), "branches": result}

TOOLS = {
    "list_branch_cities": list_branch_cities,
    "get_branch_status": get_branch_status,
    "get_branch_representatives": get_branch_representatives,
}

def lambda_handler(event, context):
    tool = _tool_name(context)
    logger.info(json.dumps({"tool": tool, "arguments": event}))
    handler = TOOLS.get(tool)
    if handler is None:
        return {"error": f"Unknown tool '{tool}'"}
    try:
        return _to_native(handler(event or {}))
    except ValueError as exc:  # input validation errors are safe to return
        return {"error": str(exc)}
    except Exception:  # never leak internals to the model
        logger.exception("Tool %s failed", tool)
        return {"error": "Internal error while processing the request."}
    
    