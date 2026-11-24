/**
 * useTaskReminders — the App-level in-app task-reminder scheduler (the
 * Google Tasks model; the pure logic lives in
 * features/calendar/taskReminders.ts). Mounted once by the App shell: it
 * derives every open task's reminder moment from the effective
 * Scheduled/Deadline values (re-derived on every client notify), fires the
 * due ones through the kit's notification store (a persistent toast with an
 * Open action — plus a browser Notification when the device setting is on
 * and permission is granted), records the fire device-locally so a moment
 * fires once per device, and arms a timer to the next future moment. A
 * midnight re-derivation rolls the day over even when nothing is pending
 * (past-day moments drop, a recurring series' new occurrence day arms).
 *
 * Device-local throughout: the enable toggle, the all-day default time, the
 * browser-notification opt-in, and the fired-state are device settings /
 * localStorage — "device state is never an op".
 */

import { useEffect, useRef } from "react";

import {
  completedOccurrencesOf,
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_UUIDS,
  TASK_CLOSED_STATUSES,
} from "@notees/domain";

import { notificationStore } from "../../components/ui/kit/notificationStore.js";
import { useClientVersion } from "../../components/ui/kit/useClientVersion.js";
import { useDeviceSetting } from "../../features/settings/deviceSettings.js";
import { scheduledIsoOf, todayIsoLocal } from "../../features/calendar/calendarViewUtils.js";
import { repeatFactsOfNode } from "../../features/calendar/repeatProperty.js";
import {
  postponeTaskToTomorrow,
  taskPostponeTargetOf,
  taskStatusLabel,
} from "../../features/calendar/calendarRows.js";
import {
  DEFAULT_ALL_DAY_REMINDER_TIME,
  dueReminders,
  markReminderFired,
  nextReminderDelay,
  readFiredReminders,
  reminderKeyOf,
  taskReminderMomentOf,
  type TaskReminderFacts,
  type TaskReminderMoment,
} from "../../features/calendar/taskReminders.js";
import { titleOf } from "../dateDisplay.js";
import type { AnyClient } from "./clients.js";

/** Re-derive at the next local midnight even with nothing pending. */
function msUntilNextMidnight(nowMs: number): number {
  const now = new Date(nowMs);
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5, 0);
  return midnight.getTime() - nowMs;
}

/** One task's reminder facts off the client's sync reads (the shells carry
 *  the raw datetime values — the clock time rides them). */
function reminderFactsOf(
  client: AnyClient,
  statusSchema: { id: string; options: Array<{ id: string; label: string }> | null } | undefined,
  id: string,
): TaskReminderFacts {
  const facts = repeatFactsOfNode(client, id);
  const props = client.getPropertyRowShells(id);
  const scheduledValue =
    props.find((prop) => prop.propertySchemaId === SYSTEM_PROPERTY_UUIDS.taskScheduled)?.value ??
    null;
  const deadlineValue =
    props.find((prop) => prop.propertySchemaId === SYSTEM_PROPERTY_UUIDS.taskDeadline)?.value ??
    null;
  const statusLabel = taskStatusLabel(
    statusSchema as Parameters<typeof taskStatusLabel>[0],
    props.find((prop) => prop.propertySchemaId === SYSTEM_PROPERTY_UUIDS.taskStatus)?.value,
  );
  return {
    taskId: id,
    closed: statusLabel !== null && TASK_CLOSED_STATUSES.has(statusLabel as "Done" | "Cancelled"),
    scheduledValue,
    deadlineValue,
    scheduledIso: scheduledIsoOf(scheduledValue),
    deadlineIso: scheduledIsoOf(deadlineValue),
    repeat: facts?.rule ?? null,
    completedOccurrences: facts === null ? [] : completedOccurrencesOf(facts.row.metadata),
  };
}

export function useTaskReminders({
  client,
  onOpenNode,
}: {
  client: AnyClient | null;
  onOpenNode: (nodeId: string) => void;
}): void {
  const [enabled] = useDeviceSetting("tasks.remindersEnabled", true);
  const [allDayTime] = useDeviceSetting("tasks.allDayReminderTime", DEFAULT_ALL_DAY_REMINDER_TIME);
  const [browserNotifications] = useDeviceSetting("tasks.browserNotifications", false);
  const version = useClientVersion(client);
  const onOpenNodeRef = useRef(onOpenNode);
  onOpenNodeRef.current = onOpenNode;

  useEffect(() => {
    if (client === null || !enabled) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const fire = (moment: TaskReminderMoment) => {
      markReminderFired(reminderKeyOf(moment), Date.now());
      const title =
        titleOf(client, moment.taskId, { read: "fallback", empty: "untitled" }) ?? "Untitled";
      const when = moment.allDay
        ? `${moment.kind === "scheduled" ? "Scheduled" : "Deadline"} today`
        : `${moment.kind === "scheduled" ? "Scheduled" : "Deadline"} at ${moment.time}`;
      notificationStore.addNotification({
        type: "info",
        title,
        message: when,
        duration: 0,
        action: { label: "Open", onClick: () => onOpenNodeRef.current(moment.taskId) },
        // The one-tap postpone rides the toast too — scheduled-driven,
        // non-recurring, point-valued tasks only (the eligibility helper is
        // the rows' own; a null target hides the action).
        ...(moment.kind === "scheduled" && taskPostponeTargetOf(client, moment.taskId) !== null
          ? {
              secondaryAction: {
                label: "Tomorrow",
                onClick: () => void postponeTaskToTomorrow(client, moment.taskId),
              },
            }
          : {}),
      });
      if (
        browserNotifications &&
        typeof Notification !== "undefined" &&
        Notification.permission === "granted"
      ) {
        try {
          new Notification(title, { body: when });
        } catch {
          // Some platforms only allow service-worker notifications — the
          // in-app toast already fired, so a construction failure is silent.
        }
      }
    };

    const arm = () => {
      if (cancelled) return;
      const nowMs = Date.now();
      const todayIso = todayIsoLocal();
      const statusSchema = client
        .listPropertySchemas()
        .find((schema) => schema.id === SYSTEM_PROPERTY_UUIDS.taskStatus);
      const moments = client
        .getClassMembers(SYSTEM_CLASS_UUIDS.task)
        .map((member) =>
          taskReminderMomentOf(
            reminderFactsOf(client, statusSchema, member.id),
            todayIso,
            allDayTime,
          ),
        )
        .filter((moment): moment is TaskReminderMoment => moment !== null);
      const firedKeys = new Set(readFiredReminders(nowMs).map((entry) => entry.key));
      for (const moment of dueReminders(moments, nowMs, firedKeys, todayIso)) {
        fire(moment);
      }
      const firedAfter = new Set(readFiredReminders(Date.now()).map((entry) => entry.key));
      const delay = nextReminderDelay(moments, Date.now(), firedAfter);
      const midnight = msUntilNextMidnight(Date.now());
      // setTimeout's practical cap is ~24.8 days; the 6h ceiling re-derives
      // long arms (and the midnight ceiling rolls the day over).
      timer = setTimeout(
        arm,
        Math.min(delay ?? Number.POSITIVE_INFINITY, midnight, 6 * 60 * 60 * 1000),
      );
    };
    arm();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [client, enabled, allDayTime, browserNotifications, version]);
}
