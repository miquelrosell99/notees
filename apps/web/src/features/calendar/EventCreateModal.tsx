/**
 * EventCreateModal — the dblclick-to-create event dialog (owner 2026-10-24,
 * the google-calendar register): a name, a start day (prefilled with the
 * dblclicked day), an optional start time, and an optional end day/time.
 * The write mirrors the drag-create register (CalendarGrid.commitCreate):
 * an `event`-classed standalone node named by its content, the system event
 * class's first datetime binding as the driving schema, and the unified
 * date union as the value — a POINT `{nodeId[, time]}` when no end day
 * differs, a RANGE `{start, end}` across days or when both times land on
 * the same day (SCHEMA.md "Datetime"). Creating opens the event; Cancel
 * just closes.
 *
 * Validation is fail-loud inline (the repo idiom): times must match
 * HH:MM (24h, minute precision), the end day must not precede the start,
 * and a name is required — malformed input never reaches the wire.
 */

import { useEffect, useState } from "react";

import { SYSTEM_CLASS_UUIDS, dayNodeId } from "@notees/domain";

import { Modal } from "../../components/ui/fleet/Modal.js";
import { TextField } from "../../components/ui/fleet/TextField.js";
import { Button } from "../../components/ui/fleet/Button.js";
import type { AnyClient } from "../../ui/app/Sidebar.js";
import "./EventCreateModal.css";

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** One datetime-union slot on the wire (`time` absent = full-day). */
type WireSlot = { nodeId: string; time?: string };

export interface EventCreateModalProps {
  /** Whether the modal is open. */
  isOpen: boolean;
  /** Callback to close the modal. */
  onClose: () => void;
  /** The workspace data surface the create writes through. */
  client: AnyClient;
  /** The dblclicked day — prefills the start day. */
  startIso: string;
  /** The dblclicked hour ("HH:MM") — prefills the start time (empty for a
      band/whole-day dblclick). */
  startTime?: string;
  /** Called with the new event's id after the writes land (the host opens it). */
  onCreated: (nodeId: string) => void;
}

export function EventCreateModal({
  isOpen,
  onClose,
  client,
  startIso,
  startTime: prefillStartTime = "",
  onCreated,
}: EventCreateModalProps) {
  const [name, setName] = useState("");
  const [startDay, setStartDay] = useState(startIso);
  const [startTime, setStartTime] = useState("");
  const [endDay, setEndDay] = useState("");
  const [endTime, setEndTime] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [startTimeError, setStartTimeError] = useState<string | null>(null);
  const [endDayError, setEndDayError] = useState<string | null>(null);
  const [endTimeError, setEndTimeError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  // Reset each time the modal opens (the dblclicked day moves with it).
  useEffect(() => {
    if (isOpen) {
      setName("");
      setStartDay(startIso);
      setStartTime(prefillStartTime);
      setEndDay("");
      setEndTime("");
      setNameError(null);
      setStartTimeError(null);
      setEndDayError(null);
      setEndTimeError(null);
      setError(null);
      setIsCreating(false);
    }
  }, [isOpen, startIso, prefillStartTime]);

  // Live-validate the optional time fields while typing (fail loud inline).
  const onStartTimeChange = (value: string): void => {
    setStartTime(value);
    setStartTimeError(value !== "" && !TIME_PATTERN.test(value) ? "Time must be HH:MM (24h)." : null);
  };
  const onEndTimeChange = (value: string): void => {
    setEndTime(value);
    setEndTimeError(value !== "" && !TIME_PATTERN.test(value) ? "Time must be HH:MM (24h)." : null);
  };
  const onEndDayChange = (value: string): void => {
    setEndDay(value);
    setEndDayError(
      value !== "" && !DAY_PATTERN.test(value) ? "End day must be a date." : null,
    );
  };

  const create = async (): Promise<void> => {
    const trimmedName = name.trim();
    if (trimmedName === "") {
      setNameError("A name is required.");
      return;
    }
    if (!DAY_PATTERN.test(startDay)) {
      setError("The start day must be a date.");
      return;
    }
    const start = startTime.trim() === "" ? null : startTime.trim();
    const end = endTime.trim() === "" ? null : endTime.trim();
    if (start !== null && !TIME_PATTERN.test(start)) {
      setStartTimeError("Time must be HH:MM (24h).");
      return;
    }
    if (end !== null && !TIME_PATTERN.test(end)) {
      setEndTimeError("Time must be HH:MM (24h).");
      return;
    }
    const endDayTrimmed = endDay.trim();
    if (endDayTrimmed !== "" && !DAY_PATTERN.test(endDayTrimmed)) {
      setEndDayError("End day must be a date.");
      return;
    }
    if (endDayTrimmed !== "" && endDayTrimmed < startDay) {
      setEndDayError("The end day cannot precede the start day.");
      return;
    }

    setIsCreating(true);
    setError(null);
    try {
      // The chain for every referenced day (the store's existence check
      // requires the slot targets to resolve).
      await client.ensureDateChain(startDay);
      const endIso = endDayTrimmed === "" || endDayTrimmed === startDay ? null : endDayTrimmed;
      if (endIso !== null) await client.ensureDateChain(endIso);

      const id = await client.createObject({
        isEmbedded: false,
        classIds: [SYSTEM_CLASS_UUIDS.event],
        // Title-is-content: the name IS the node's initial text content.
        name: trimmedName,
      });

      // The driving date schema: the system event class's first binding
      // (the drag-create register — CalendarGrid.commitCreate).
      const schemaId = client
        .getClassBindings(SYSTEM_CLASS_UUIDS.event)
        .map((binding) => binding.propertySchemaId)
        .find((bindingSchemaId) => bindingSchemaId !== undefined);
      if (schemaId !== undefined) {
        const slot = (iso: string, time: string | null): WireSlot => {
          const base: WireSlot = { nodeId: dayNodeId(iso) };
          if (time !== null) base.time = time;
          return base;
        };
        // The unified date union: a bare point without an end day; a range
        // across differing days; both slots on the start day when only
        // times were given (same-day timed register).
        const value: WireSlot | { start: WireSlot; end: WireSlot } =
          endIso === null && end === null
            ? start === null
              ? slot(startDay, null)
              : slot(startDay, start)
            : {
                start: slot(startDay, start),
                end: slot(endIso ?? startDay, end),
              };
        await client.setProperty(id, schemaId, value, 0);
      }
      onCreated(id);
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to create the event.");
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="New event"
      size="sm"
      footer={
        <div className="event-create-modal__footer">
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            icon="mdi-plus"
            disabled={isCreating || trimmedDisabled(name)}
            onClick={() => void create()}
          >
            {isCreating ? "Creating…" : "Create"}
          </Button>
        </div>
      }
    >
      <div className="event-create-modal">
        <TextField
          label="Name"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setNameError(null);
          }}
          {...(nameError !== null ? { error: true as const, errorMessage: nameError } : {})}
          placeholder="Team offsite"
          autoComplete="off"
        />
        <div className="event-create-modal__row">
          <TextField
            label="Start day"
            type="date"
            value={startDay}
            onChange={(event) => setStartDay(event.target.value)}
          />
          <TextField
            label="Start time"
            value={startTime}
            onChange={(event) => onStartTimeChange(event.target.value)}
            {...(startTimeError !== null ? { error: true as const, errorMessage: startTimeError } : {})}
            placeholder="HH:MM"
            autoComplete="off"
          />
        </div>
        <div className="event-create-modal__row">
          <TextField
            label="End day"
            type="date"
            value={endDay}
            onChange={(event) => onEndDayChange(event.target.value)}
            {...(endDayError !== null ? { error: true as const, errorMessage: endDayError } : {})}
          />
          <TextField
            label="End time"
            value={endTime}
            onChange={(event) => onEndTimeChange(event.target.value)}
            {...(endTimeError !== null ? { error: true as const, errorMessage: endTimeError } : {})}
            placeholder="HH:MM"
            autoComplete="off"
          />
        </div>
        <p className="event-create-modal__hint">
          Leave the times empty for a full-day event; set an end day (or an
          end time) for a range.
        </p>
        {error !== null && (
          <p className="event-create-modal__error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

/** The Create button disables on a blank name (the one hard requirement). */
function trimmedDisabled(name: string): boolean {
  return name.trim() === "";
}
