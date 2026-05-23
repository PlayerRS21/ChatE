#!/usr/bin/env python3
from __future__ import annotations

import base64
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


private_key = ec.generate_private_key(ec.SECP256R1())
private_der = private_key.private_bytes(
    encoding=serialization.Encoding.DER,
    format=serialization.PrivateFormat.PKCS8,
    encryption_algorithm=serialization.NoEncryption(),
)
public_numbers = private_key.public_key().public_numbers()
public_raw = b"\x04" + public_numbers.x.to_bytes(32, "big") + public_numbers.y.to_bytes(32, "big")

print("# Copy these into your project-root .env")
print("# Private key format is pywebpush-native base64url DER, not PEM.")
print("CHATE_VAPID_PUBLIC_KEY=" + b64url(public_raw))
print("CHATE_VAPID_PRIVATE_KEY=" + b64url(private_der))
print("CHATE_VAPID_SUBJECT=mailto:riteshsaini033@gmail.com")
