"""Firebase Cloud Messaging (FCM) push notification adapter.

This adapter uses the legacy FCM HTTP API because it only requires a single
server key, which keeps self-hosted setup simple. Operators who prefer the
HTTP v1 API can replace this adapter with a custom implementation of the
``PushNotificationSender`` port.
"""

from __future__ import annotations

from typing import Any

import httpx

from app.config import Settings
from app.domain.ports import PushNotification, PushNotificationSender, PushSendResult


class FcmPushSender(PushNotificationSender):
    """Send push notifications through Firebase Cloud Messaging.

    Active only when ``FCM_SERVER_KEY`` is configured. The adapter batches
    tokens and sends them concurrently for reasonable throughput.
    """

    _FCM_LEGACY_URL = "https://fcm.googleapis.com/fcm/send"
    _BATCH_SIZE = 500

    def __init__(self, settings: Settings):
        self._server_key = settings.fcm_server_key
        self._timeout = 10.0

    def is_configured(self) -> bool:
        return bool(self._server_key)

    async def send_to_tokens(
        self,
        tokens: list[str],
        notification: PushNotification,
    ) -> PushSendResult:
        if not self._server_key:
            return PushSendResult(success=False, message="FCM server key not configured")

        if not tokens:
            return PushSendResult(success=True, message="No tokens to send")

        headers = {
            "Authorization": f"key={self._server_key}",
            "Content-Type": "application/json",
        }

        results: list[PushSendResult] = []
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            # Legacy FCM supports up to 500 registration IDs per request.
            for i in range(0, len(tokens), self._BATCH_SIZE):
                batch = tokens[i : i + self._BATCH_SIZE]
                payload: dict[str, Any] = {
                    "registration_ids": batch,
                    "notification": {
                        "title": notification.title,
                        "body": notification.body,
                    },
                    "data": notification.data or {},
                }
                result = await self._send_batch(client, headers, payload)
                results.append(result)

        failures = [r for r in results if not r.success]
        if failures:
            return PushSendResult(
                success=False,
                message=f"{len(failures)} batch(es) failed: {failures[0].message}",
            )
        return PushSendResult(success=True, message=f"Sent to {len(tokens)} token(s)")

    async def _send_batch(
        self,
        client: httpx.AsyncClient,
        headers: dict[str, str],
        payload: dict[str, Any],
    ) -> PushSendResult:
        try:
            response = await client.post(
                self._FCM_LEGACY_URL,
                headers=headers,
                json=payload,
            )
        except (TimeoutError, httpx.HTTPError) as e:
            return PushSendResult(success=False, message=f"FCM request failed: {e}")

        if response.status_code != 200:
            return PushSendResult(
                success=False,
                message=f"FCM returned HTTP {response.status_code}: {response.text}",
            )

        return PushSendResult(success=True, message="Batch accepted by FCM")
