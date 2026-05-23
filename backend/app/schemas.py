from datetime import datetime
from typing import Any, Literal
import re

from pydantic import BaseModel, EmailStr, Field, field_validator

CONTROL_CHAR_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
BASE64ISH_RE = re.compile(r"^[A-Za-z0-9+/=_\-.~:;,]+$")


def reject_control_chars(value: str, field: str) -> str:
    if CONTROL_CHAR_RE.search(value):
        raise ValueError(f"{field} contains invalid control characters")
    return value


def validate_encrypted_text(value: str, field: str, max_len: int) -> str:
    value = reject_control_chars(value, field)
    if len(value) > max_len:
        raise ValueError(f"{field} is too large")
    return value


class PublicUser(BaseModel):
    id: int
    username: str
    email: EmailStr | None = None
    display_name: str | None = None
    avatar_url: str | None = None
    bio: str | None = None
    public_key_jwk: dict[str, Any] | None = None
    created_at: datetime | None = None
    deletion_requested_at: datetime | None = None
    deletion_scheduled_at: datetime | None = None
    last_login_at: datetime | None = None
    last_seen_at: datetime | None = None
    auto_delete_after_days: int | None = None
    email_verified_at: datetime | None = None
    default_disappearing_seconds: int | None = None
    public_show_email: bool = False
    public_show_display_name: bool = True
    public_show_avatar: bool = True
    public_show_bio: bool = True
    public_show_last_seen: bool = False


class RegisterRequest(BaseModel):
    username: str = Field(min_length=3, max_length=40)
    email: EmailStr
    password: str = Field(min_length=8, max_length=200)
    display_name: str | None = Field(default=None, max_length=80)
    public_key_jwk: dict[str, Any]

    @field_validator("username")
    @classmethod
    def clean_username(cls, value: str) -> str:
        value = value.strip().lower()
        allowed = set("abcdefghijklmnopqrstuvwxyz0123456789_-.@")
        if not value or any(ch not in allowed for ch in value):
            raise ValueError("username may contain letters, numbers, underscore, dash, dot, and @ only")
        return value


class LoginRequest(BaseModel):
    login: str = Field(min_length=3, max_length=255)
    password: str = Field(min_length=8, max_length=200)




class AuthFlowResponse(BaseModel):
    status: str = "ok"
    detail: str


class ForgotUsernameRequest(BaseModel):
    email: EmailStr


class PasswordResetStartRequest(BaseModel):
    login: str = Field(min_length=3, max_length=255)


class PasswordResetCompleteRequest(BaseModel):
    token: str = Field(min_length=20, max_length=240)
    new_password: str = Field(min_length=8, max_length=200)

    @field_validator("token")
    @classmethod
    def clean_token(cls, value: str) -> str:
        value = reject_control_chars(value.strip(), "token")
        if not re.fullmatch(r"[A-Za-z0-9_\-.~]+", value):
            raise ValueError("invalid token")
        return value


class EmailVerificationCompleteRequest(BaseModel):
    token: str = Field(min_length=20, max_length=240)

    @field_validator("token")
    @classmethod
    def clean_token(cls, value: str) -> str:
        value = reject_control_chars(value.strip(), "token")
        if not re.fullmatch(r"[A-Za-z0-9_\-.~]+", value):
            raise ValueError("invalid token")
        return value


class PublicKeyUpdate(BaseModel):
    public_key_jwk: dict[str, Any]


class ProfileUpdate(BaseModel):
    display_name: str | None = Field(default=None, max_length=80)
    avatar_url: str | None = Field(default=None, max_length=500)
    bio: str | None = Field(default=None, max_length=280)
    public_show_email: bool = False
    public_show_display_name: bool = True
    public_show_avatar: bool = True
    public_show_bio: bool = True
    public_show_last_seen: bool = False

    @field_validator("display_name", "avatar_url", "bio")
    @classmethod
    def clean_public_profile_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return reject_control_chars(value.strip(), "profile field")


class AvatarUpload(BaseModel):
    image_data_url: str = Field(min_length=20, max_length=4_500_000)


class PasswordChangeRequest(BaseModel):
    current_password: str = Field(min_length=8, max_length=200)
    new_password: str = Field(min_length=8, max_length=200)


class AccountSettingsOut(BaseModel):
    username: str
    email: EmailStr
    display_name: str | None = None
    avatar_url: str | None = None
    bio: str | None = None
    last_login_at: datetime | None = None
    last_seen_at: datetime | None = None
    auto_delete_after_days: int | None = None
    default_disappearing_seconds: int | None = None
    email_verified_at: datetime | None = None
    deletion_requested_at: datetime | None = None
    deletion_scheduled_at: datetime | None = None
    public_show_email: bool = False
    public_show_display_name: bool = True
    public_show_avatar: bool = True
    public_show_bio: bool = True
    public_show_last_seen: bool = False


class AccountSettingsUpdate(BaseModel):
    # Null disables automatic deletion. Otherwise allow practical MVP range: 1 day to 10 years.
    auto_delete_after_days: int | None = Field(default=None, ge=1, le=3650)
    # Null/0 disables disappearing messages. Maximum is 1 year for the MVP.
    default_disappearing_seconds: int | None = Field(default=None, ge=0, le=31536000)


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: PublicUser
    deletion_was_cancelled: bool = False


class KeySessionCreate(BaseModel):
    id: str = Field(min_length=16, max_length=64)
    receiver_id: int
    encrypted_key_for_receiver: str = Field(min_length=1, max_length=12000)
    encrypted_key_for_sender: str = Field(min_length=1, max_length=12000)


class KeySessionOut(BaseModel):
    id: str
    sender_id: int
    receiver_id: int
    encrypted_key_for_receiver: str
    encrypted_key_for_sender: str
    created_at: datetime
    expires_at: datetime


class MessageReactionOut(BaseModel):
    emoji: str
    user_id: int
    username: str | None = None
    created_at: datetime | None = None


class MessageEditRequest(BaseModel):
    ciphertext: str = Field(min_length=1, max_length=1_500_000)
    iv: str = Field(min_length=1, max_length=512)
    key_session_id: str | None = Field(default=None, min_length=16, max_length=64)
    encrypted_key_for_receiver: str | None = Field(default=None, max_length=12000)
    encrypted_key_for_sender: str | None = Field(default=None, max_length=12000)

    @field_validator("ciphertext", "iv", "key_session_id", "encrypted_key_for_receiver", "encrypted_key_for_sender")
    @classmethod
    def clean_crypto_payload(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return validate_encrypted_text(value, "encrypted payload", 1_500_000)


class MessageReactionRequest(BaseModel):
    emoji: str = Field(min_length=1, max_length=16)

    @field_validator("emoji")
    @classmethod
    def clean_emoji(cls, value: str) -> str:
        cleaned = reject_control_chars(value.strip(), "emoji")
        if not cleaned:
            raise ValueError("emoji is required")
        return cleaned[:16]


class UrlImportRequest(BaseModel):
    url: str = Field(min_length=8, max_length=1500)


class UrlImportOut(BaseModel):
    label: str
    mime_type: str
    size_bytes: int
    data_url: str


class BlobUploadStart(BaseModel):
    receiver_id: int
    original_name: str | None = Field(default=None, max_length=255)
    mime_type: str | None = Field(default=None, max_length=120)
    total_size: int = Field(ge=1, le=104857600)
    total_chunks: int = Field(ge=1, le=512)

    @field_validator("original_name", "mime_type")
    @classmethod
    def clean_blob_meta(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return reject_control_chars(value.strip(), "blob metadata")


class BlobUploadStartOut(BaseModel):
    upload_id: str
    chunk_size_limit: int


class BlobUploadComplete(BaseModel):
    upload_id: str = Field(min_length=16, max_length=64)


class MessageCreate(BaseModel):
    receiver_id: int
    message_type: Literal["text", "image", "video", "voice", "file", "gif", "sticker"] = "text"
    client_message_id: str | None = Field(default=None, min_length=6, max_length=96)
    ciphertext: str = Field(min_length=1, max_length=1_500_000)
    iv: str = Field(min_length=1, max_length=512)
    key_session_id: str | None = Field(default=None, min_length=16, max_length=64)
    blob_id: str | None = Field(default=None, min_length=16, max_length=64)
    reply_to_id: int | None = Field(default=None, ge=1)
    # Legacy fallback fields. v10 uses key_session_id for lower RSA overhead.
    encrypted_key_for_receiver: str | None = Field(default=None, max_length=12000)
    encrypted_key_for_sender: str | None = Field(default=None, max_length=12000)

    @field_validator("client_message_id", "ciphertext", "iv", "key_session_id", "blob_id", "encrypted_key_for_receiver", "encrypted_key_for_sender")
    @classmethod
    def clean_message_payload(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return validate_encrypted_text(value, "message payload", 1_500_000)


class MessageOut(BaseModel):
    id: int
    sender_id: int
    receiver_id: int
    message_type: str
    client_message_id: str | None = None
    ciphertext: str
    iv: str
    encrypted_key_for_receiver: str | None = Field(default=None, max_length=12000)
    encrypted_key_for_sender: str | None = Field(default=None, max_length=12000)
    key_session_id: str | None = None
    blob_id: str | None = None
    blob_url: str | None = None
    session_encrypted_key_for_receiver: str | None = None
    session_encrypted_key_for_sender: str | None = None
    session_expires_at: datetime | None = None
    created_at: datetime
    expires_at: datetime | None = None
    edited_at: datetime | None = None
    reply_to_id: int | None = None
    reactions: list[MessageReactionOut] = Field(default_factory=list)
    delivered_at: datetime | None = None
    read_at: datetime | None = None


class ConversationOut(BaseModel):
    other_user: PublicUser
    latest_message: MessageOut
    unread_count: int = 0


class DeletionRequestOut(BaseModel):
    deletion_requested_at: datetime
    deletion_scheduled_at: datetime

class PresenceUpdate(BaseModel):
    status: Literal["online", "idle", "typing", "recording", "offline"] = "online"
    peer_id: int | None = None


class PresenceOut(BaseModel):
    user_id: int
    status: Literal["online", "idle", "typing", "recording", "offline"]
    last_seen_at: datetime | None = None
    peer_id: int | None = None


class BlockedUserOut(BaseModel):
    id: int
    blocked_user: PublicUser
    created_at: datetime


class BlobOut(BaseModel):
    id: str
    owner_id: int
    receiver_id: int
    original_name: str | None = None
    mime_type: str | None = None
    size_bytes: int
    download_url: str
    created_at: datetime


class KeyHistoryOut(BaseModel):
    id: int
    user_id: int
    fingerprint: str
    event_type: str
    created_at: datetime



class UserReportCreate(BaseModel):
    reported_user_id: int
    reason: str = Field(min_length=3, max_length=120)
    details: str | None = Field(default=None, max_length=2000)
    evidence: list[dict[str, Any]] | None = Field(default=None, max_length=20)

    @field_validator("reason", "details")
    @classmethod
    def clean_report_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return reject_control_chars(value.strip(), "report text")


class UserReportOut(BaseModel):
    id: int
    reporter_id: int
    reported_id: int
    reason: str
    details: str | None = None
    status: str
    created_at: datetime


class PushSubscriptionKeys(BaseModel):
    p256dh: str = Field(min_length=16, max_length=512)
    auth: str = Field(min_length=8, max_length=512)

    @field_validator("p256dh", "auth")
    @classmethod
    def clean_push_key(cls, value: str) -> str:
        return validate_encrypted_text(value.strip(), "push key", 512)


class PushSubscriptionIn(BaseModel):
    endpoint: str = Field(min_length=20, max_length=2500)
    keys: PushSubscriptionKeys
    device_id: str | None = Field(default=None, min_length=16, max_length=64)

    @field_validator("endpoint", "device_id")
    @classmethod
    def clean_push_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return reject_control_chars(value.strip(), "push subscription")


class PushSubscriptionOut(BaseModel):
    enabled: bool
    detail: str
    public_key: str | None = None


class DeviceRegisterRequest(BaseModel):
    device_id: str = Field(min_length=16, max_length=64)
    name: str = Field(min_length=1, max_length=120)
    public_key_jwk: dict[str, Any] | None = None

    @field_validator("device_id", "name")
    @classmethod
    def clean_device_text(cls, value: str) -> str:
        return reject_control_chars(value.strip(), "device field")


class DeviceOut(BaseModel):
    id: str
    name: str
    status: str = "trusted"
    created_at: datetime
    approved_at: datetime | None = None
    last_seen_at: datetime | None = None
    revoked_at: datetime | None = None


class DeviceTrustRequest(BaseModel):
    device_id: str = Field(min_length=16, max_length=64)
    name: str = Field(min_length=1, max_length=120)
    public_key_jwk: dict[str, Any] | None = None

    @field_validator("device_id", "name")
    @classmethod
    def clean_device_text(cls, value: str) -> str:
        return reject_control_chars(value.strip(), "device field")


class DeviceTrustOut(BaseModel):
    device: DeviceOut
    status: str
    requires_approval: bool = False
    link_session_id: str | None = None
    detail: str


class DeviceLinkStartRequest(BaseModel):
    device_id: str = Field(min_length=16, max_length=64)
    device_name: str = Field(min_length=1, max_length=120)
    public_key_jwk: dict[str, Any] | None = None

    @field_validator("device_id", "device_name")
    @classmethod
    def clean_device_link_text(cls, value: str) -> str:
        return reject_control_chars(value.strip(), "device link field")


class DeviceLinkSessionOut(BaseModel):
    id: str
    user_id: int
    new_device_id: str
    new_device_name: str
    status: str
    created_at: datetime
    expires_at: datetime
    approved_at: datetime | None = None
    rejected_at: datetime | None = None
    email_requested_at: datetime | None = None
    email_approved_at: datetime | None = None
    consumed_at: datetime | None = None
    qr_payload: str | None = None
    new_device_public_key_jwk: dict[str, Any] | None = None


class DeviceLinkApproveRequest(BaseModel):
    encrypted_key_package_json: str = Field(min_length=20, max_length=2_000_000)

    @field_validator("encrypted_key_package_json")
    @classmethod
    def clean_package(cls, value: str) -> str:
        return reject_control_chars(value.strip(), "encrypted key package")


class DeviceLinkCompleteOut(BaseModel):
    encrypted_key_package_json: str | None = None
    status: str = "approved"
    detail: str = "Import this package locally with the same key passphrase."


class DeviceLostStartOut(BaseModel):
    status: str = "ok"
    detail: str


class DeviceLostConfirmRequest(BaseModel):
    token: str = Field(min_length=20, max_length=240)

    @field_validator("token")
    @classmethod
    def clean_token(cls, value: str) -> str:
        value = reject_control_chars(value.strip(), "token")
        if not re.fullmatch(r"[A-Za-z0-9_\-.~]+", value):
            raise ValueError("invalid token")
        return value


class ConversationSettingsOut(BaseModel):
    other_user_id: int
    disappearing_seconds: int | None = None
    updated_by_id: int | None = None
    updated_at: datetime | None = None


class ConversationSettingsUpdate(BaseModel):
    disappearing_seconds: int | None = Field(default=None, ge=0, le=31536000)
