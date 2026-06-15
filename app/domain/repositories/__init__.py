"""Repository implementations package."""

from .interfaces import (
    ActivityRepository,
    AssetRepository,
    ExportRepository,
    InviteRepository,
    LinkRepository,
    MentionRepository,
    NodeRepository,
    NodeViewRepository,
    NotificationRepository,
    PropertyRepository,
    QueryRepository,
    SettingsRepository,
    ShareRepository,
    SyncRepository,
    TaskCompletionRepository,
    TaskRecurrenceRepository,
    UndoRepository,
    UserRepository,
    WorkspaceRepository,
)
from .postgres_activity import PostgresActivityRepository
from .postgres_asset import PostgresAssetRepository
from .postgres_class_extend import PostgresClassExtendRepository
from .postgres_export import PostgresExportRepository
from .postgres_invite import PostgresInviteRepository
from .postgres_link import PostgresLinkRepository
from .postgres_mention import PostgresMentionRepository
from .postgres_node import PostgresNodeRepository
from .postgres_node_view import PostgresNodeViewRepository
from .postgres_notification import PostgresNotificationRepository
from .postgres_property import PostgresPropertyRepository
from .postgres_query import PostgresQueryRepository
from .postgres_settings import PostgresSettingsRepository
from .postgres_share import PostgresShareRepository
from .postgres_sync import PostgresSyncRepository
from .postgres_task_completion import PostgresTaskCompletionRepository
from .postgres_task_recurrence import PostgresTaskRecurrenceRepository
from .postgres_undo import PostgresUndoRepository
from .postgres_user import PostgresUserRepository
from .postgres_workspace import PostgresWorkspaceRepository

__all__ = [
    # Interfaces
    "NodeRepository",
    "PropertyRepository",
    "LinkRepository",
    "MentionRepository",
    "UserRepository",
    "ActivityRepository",
    "AssetRepository",
    "SettingsRepository",
    "ShareRepository",
    "SyncRepository",
    "TaskCompletionRepository",
    "TaskRecurrenceRepository",
    "UndoRepository",
    "WorkspaceRepository",
    "ExportRepository",
    "NodeViewRepository",
    "NotificationRepository",
    "InviteRepository",
    "QueryRepository",
    # PostgreSQL implementations
    "PostgresNodeRepository",
    "PostgresPropertyRepository",
    "PostgresLinkRepository",
    "PostgresMentionRepository",
    "PostgresUserRepository",
    "PostgresNodeViewRepository",
    "PostgresClassExtendRepository",
    "PostgresActivityRepository",
    "PostgresAssetRepository",
    "PostgresSettingsRepository",
    "PostgresShareRepository",
    "PostgresSyncRepository",
    "PostgresTaskCompletionRepository",
    "PostgresTaskRecurrenceRepository",
    "PostgresUndoRepository",
    "PostgresWorkspaceRepository",
    "PostgresExportRepository",
    "PostgresNotificationRepository",
    "PostgresInviteRepository",
    "PostgresQueryRepository",
]
