"""Tests for subscription tier API endpoints."""

from unittest.mock import AsyncMock, Mock

import fastapi
import fastapi.testclient
import pytest
import pytest_mock
import stripe
from autogpt_libs.auth.jwt_utils import get_jwt_payload
from prisma.enums import SubscriptionTier

from .v1 import v1_router

TEST_USER_ID = "3e53486c-cf57-477e-ba2a-cb02dc828e1a"
TEST_FRONTEND_ORIGIN = "https://app.example.com"


@pytest.fixture()
def client() -> fastapi.testclient.TestClient:
    """Fresh FastAPI app + client per test with auth override applied.

    Using a fixture avoids the leaky global-app + try/finally teardown pattern:
    if a test body raises before teardown_auth runs, dependency overrides were
    previously leaking into subsequent tests.
    """
    app = fastapi.FastAPI()
    app.include_router(v1_router)

    def override_get_jwt_payload(request: fastapi.Request) -> dict[str, str]:
        return {"sub": TEST_USER_ID, "role": "user", "email": "test@example.com"}

    app.dependency_overrides[get_jwt_payload] = override_get_jwt_payload
    try:
        yield fastapi.testclient.TestClient(app)
    finally:
        app.dependency_overrides.clear()


@pytest.fixture(autouse=True)
def _configure_frontend_origin(mocker: pytest_mock.MockFixture) -> None:
    """Pin the configured frontend origin used by the open-redirect guard."""
    from backend.api.features import v1 as v1_mod

    mocker.patch.object(
        v1_mod.settings.config, "frontend_base_url", TEST_FRONTEND_ORIGIN
    )


def test_get_subscription_status_pro(
    client: fastapi.testclient.TestClient,
    mocker: pytest_mock.MockFixture,
) -> None:
    """GET /credits/subscription returns PRO tier with Stripe price for a PRO user."""
    mock_user = Mock()
    mock_user.subscription_tier = SubscriptionTier.PRO

    mock_price = Mock()
    mock_price.unit_amount = 1999  # $19.99

    async def mock_price_id(tier: SubscriptionTier) -> str | None:
        return "price_pro" if tier == SubscriptionTier.PRO else None

    mocker.patch(
        "backend.api.features.v1.get_user_by_id",
        new_callable=AsyncMock,
        return_value=mock_user,
    )
    mocker.patch(
        "backend.api.features.v1.get_subscription_price_id",
        side_effect=mock_price_id,
    )
    mocker.patch(
        "backend.api.features.v1.stripe.Price.retrieve",
        return_value=mock_price,
    )

    response = client.get("/credits/subscription")

    assert response.status_code == 200
    data = response.json()
    assert data["tier"] == "PRO"
    assert data["monthly_cost"] == 1999
    assert data["tier_costs"]["PRO"] == 1999
    assert data["tier_costs"]["BUSINESS"] == 0
    assert data["tier_costs"]["FREE"] == 0


def test_get_subscription_status_defaults_to_free(
    client: fastapi.testclient.TestClient,
    mocker: pytest_mock.MockFixture,
) -> None:
    """GET /credits/subscription when subscription_tier is None defaults to FREE."""
    mock_user = Mock()
    mock_user.subscription_tier = None

    mocker.patch(
        "backend.api.features.v1.get_user_by_id",
        new_callable=AsyncMock,
        return_value=mock_user,
    )
    mocker.patch(
        "backend.api.features.v1.get_subscription_price_id",
        new_callable=AsyncMock,
        return_value=None,
    )

    response = client.get("/credits/subscription")

    assert response.status_code == 200
    data = response.json()
    assert data["tier"] == SubscriptionTier.FREE.value
    assert data["monthly_cost"] == 0
    assert data["tier_costs"] == {
        "FREE": 0,
        "PRO": 0,
        "BUSINESS": 0,
        "ENTERPRISE": 0,
    }


def test_update_subscription_tier_free_no_payment(
    client: fastapi.testclient.TestClient,
    mocker: pytest_mock.MockFixture,
) -> None:
    """POST /credits/subscription to FREE tier when payment disabled skips Stripe."""
    mock_user = Mock()
    mock_user.subscription_tier = SubscriptionTier.PRO

    async def mock_feature_disabled(*args, **kwargs):
        return False

    mocker.patch(
        "backend.api.features.v1.get_user_by_id",
        new_callable=AsyncMock,
        return_value=mock_user,
    )
    mocker.patch(
        "backend.api.features.v1.is_feature_enabled",
        side_effect=mock_feature_disabled,
    )
    mocker.patch(
        "backend.api.features.v1.set_subscription_tier",
        new_callable=AsyncMock,
    )

    response = client.post("/credits/subscription", json={"tier": "FREE"})

    assert response.status_code == 200
    assert response.json()["url"] == ""


def test_update_subscription_tier_paid_beta_user(
    client: fastapi.testclient.TestClient,
    mocker: pytest_mock.MockFixture,
) -> None:
    """POST /credits/subscription for paid tier when payment disabled sets tier directly."""
    mock_user = Mock()
    mock_user.subscription_tier = SubscriptionTier.FREE

    async def mock_feature_disabled(*args, **kwargs):
        return False

    mocker.patch(
        "backend.api.features.v1.get_user_by_id",
        new_callable=AsyncMock,
        return_value=mock_user,
    )
    mocker.patch(
        "backend.api.features.v1.is_feature_enabled",
        side_effect=mock_feature_disabled,
    )
    mocker.patch(
        "backend.api.features.v1.set_subscription_tier",
        new_callable=AsyncMock,
    )

    response = client.post("/credits/subscription", json={"tier": "PRO"})

    assert response.status_code == 200
    assert response.json()["url"] == ""


def test_update_subscription_tier_paid_requires_urls(
    client: fastapi.testclient.TestClient,
    mocker: pytest_mock.MockFixture,
) -> None:
    """POST /credits/subscription for paid tier without success/cancel URLs returns 422."""
    mock_user = Mock()
    mock_user.subscription_tier = SubscriptionTier.FREE

    async def mock_feature_enabled(*args, **kwargs):
        return True

    mocker.patch(
        "backend.api.features.v1.get_user_by_id",
        new_callable=AsyncMock,
        return_value=mock_user,
    )
    mocker.patch(
        "backend.api.features.v1.is_feature_enabled",
        side_effect=mock_feature_enabled,
    )

    response = client.post("/credits/subscription", json={"tier": "PRO"})

    assert response.status_code == 422


def test_update_subscription_tier_creates_checkout(
    client: fastapi.testclient.TestClient,
    mocker: pytest_mock.MockFixture,
) -> None:
    """POST /credits/subscription creates Stripe Checkout Session for paid upgrade."""
    mock_user = Mock()
    mock_user.subscription_tier = SubscriptionTier.FREE

    async def mock_feature_enabled(*args, **kwargs):
        return True

    mocker.patch(
        "backend.api.features.v1.get_user_by_id",
        new_callable=AsyncMock,
        return_value=mock_user,
    )
    mocker.patch(
        "backend.api.features.v1.is_feature_enabled",
        side_effect=mock_feature_enabled,
    )
    mocker.patch(
        "backend.api.features.v1.create_subscription_checkout",
        new_callable=AsyncMock,
        return_value="https://checkout.stripe.com/pay/cs_test_abc",
    )

    response = client.post(
        "/credits/subscription",
        json={
            "tier": "PRO",
            "success_url": f"{TEST_FRONTEND_ORIGIN}/success",
            "cancel_url": f"{TEST_FRONTEND_ORIGIN}/cancel",
        },
    )

    assert response.status_code == 200
    assert response.json()["url"] == "https://checkout.stripe.com/pay/cs_test_abc"


def test_update_subscription_tier_rejects_open_redirect(
    client: fastapi.testclient.TestClient,
    mocker: pytest_mock.MockFixture,
) -> None:
    """POST /credits/subscription rejects success/cancel URLs outside the frontend origin."""
    mock_user = Mock()
    mock_user.subscription_tier = SubscriptionTier.FREE

    async def mock_feature_enabled(*args, **kwargs):
        return True

    mocker.patch(
        "backend.api.features.v1.get_user_by_id",
        new_callable=AsyncMock,
        return_value=mock_user,
    )
    mocker.patch(
        "backend.api.features.v1.is_feature_enabled",
        side_effect=mock_feature_enabled,
    )
    checkout_mock = mocker.patch(
        "backend.api.features.v1.create_subscription_checkout",
        new_callable=AsyncMock,
    )

    response = client.post(
        "/credits/subscription",
        json={
            "tier": "PRO",
            "success_url": "https://evil.example.org/phish",
            "cancel_url": f"{TEST_FRONTEND_ORIGIN}/cancel",
        },
    )

    assert response.status_code == 422
    checkout_mock.assert_not_awaited()


def test_update_subscription_tier_enterprise_blocked(
    client: fastapi.testclient.TestClient,
    mocker: pytest_mock.MockFixture,
) -> None:
    """ENTERPRISE users cannot self-service change tiers — must get 403."""
    mock_user = Mock()
    mock_user.subscription_tier = SubscriptionTier.ENTERPRISE

    mocker.patch(
        "backend.api.features.v1.get_user_by_id",
        new_callable=AsyncMock,
        return_value=mock_user,
    )
    set_tier_mock = mocker.patch(
        "backend.api.features.v1.set_subscription_tier",
        new_callable=AsyncMock,
    )

    response = client.post(
        "/credits/subscription",
        json={
            "tier": "PRO",
            "success_url": f"{TEST_FRONTEND_ORIGIN}/success",
            "cancel_url": f"{TEST_FRONTEND_ORIGIN}/cancel",
        },
    )

    assert response.status_code == 403
    set_tier_mock.assert_not_awaited()


def test_update_subscription_tier_free_with_payment_cancels_stripe(
    client: fastapi.testclient.TestClient,
    mocker: pytest_mock.MockFixture,
) -> None:
    """Downgrading to FREE cancels active Stripe subscription when payment is enabled."""
    mock_user = Mock()
    mock_user.subscription_tier = SubscriptionTier.PRO

    async def mock_feature_enabled(*args, **kwargs):
        return True

    mock_cancel = mocker.patch(
        "backend.api.features.v1.cancel_stripe_subscription",
        new_callable=AsyncMock,
    )
    mocker.patch(
        "backend.api.features.v1.get_user_by_id",
        new_callable=AsyncMock,
        return_value=mock_user,
    )
    mocker.patch(
        "backend.api.features.v1.set_subscription_tier",
        new_callable=AsyncMock,
    )
    mocker.patch(
        "backend.api.features.v1.is_feature_enabled",
        side_effect=mock_feature_enabled,
    )

    response = client.post("/credits/subscription", json={"tier": "FREE"})

    assert response.status_code == 200
    mock_cancel.assert_awaited_once()


def test_update_subscription_tier_free_cancel_failure_returns_502(
    client: fastapi.testclient.TestClient,
    mocker: pytest_mock.MockFixture,
) -> None:
    """Downgrading to FREE returns 502 with a generic error (no Stripe detail leakage)."""
    mock_user = Mock()
    mock_user.subscription_tier = SubscriptionTier.PRO

    async def mock_feature_enabled(*args, **kwargs):
        return True

    mocker.patch(
        "backend.api.features.v1.cancel_stripe_subscription",
        side_effect=stripe.StripeError(
            "You did not provide an API key — internal detail that must not leak"
        ),
    )
    mocker.patch(
        "backend.api.features.v1.get_user_by_id",
        new_callable=AsyncMock,
        return_value=mock_user,
    )
    mocker.patch(
        "backend.api.features.v1.is_feature_enabled",
        side_effect=mock_feature_enabled,
    )

    response = client.post("/credits/subscription", json={"tier": "FREE"})

    assert response.status_code == 502
    detail = response.json()["detail"]
    # The raw Stripe error message must not appear in the client-facing detail.
    assert "API key" not in detail
    assert "contact support" in detail.lower()


def test_stripe_webhook_dispatches_subscription_events(
    client: fastapi.testclient.TestClient,
    mocker: pytest_mock.MockFixture,
) -> None:
    """POST /credits/stripe_webhook routes customer.subscription.created to sync handler."""
    stripe_sub_obj = {
        "id": "sub_test",
        "customer": "cus_test",
        "status": "active",
        "items": {"data": [{"price": {"id": "price_pro"}}]},
    }
    event = {
        "type": "customer.subscription.created",
        "data": {"object": stripe_sub_obj},
    }

    mocker.patch(
        "backend.api.features.v1.stripe.Webhook.construct_event",
        return_value=event,
    )
    sync_mock = mocker.patch(
        "backend.api.features.v1.sync_subscription_from_stripe",
        new_callable=AsyncMock,
    )

    response = client.post(
        "/credits/stripe_webhook",
        content=b"{}",
        headers={"stripe-signature": "t=1,v1=abc"},
    )

    assert response.status_code == 200
    sync_mock.assert_awaited_once_with(stripe_sub_obj)
