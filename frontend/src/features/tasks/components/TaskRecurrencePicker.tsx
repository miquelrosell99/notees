/**
 * TaskRecurrencePicker — create or edit a dedicated recurrence rule.
 *
 * Offers a compact, rule-type-driven form. Daily/Weekday are one-click;
 * Weekly supports day-of-week selection; Monthly supports either a fixed
 * day-of-month or an Nth-weekday pattern; Yearly supports month + day.
 */
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { SelectionButton } from '@/components/ui/SelectionButton';
import { TextField } from '@/components/ui/TextField';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import type { RecurrenceRule, RecurrenceRuleInput } from '@/types/api';
import './TaskRecurrencePicker.css';

const RULE_TYPES: Array<{ value: RecurrenceRuleInput['rule_type']; label: string; icon: string }> = [
  { value: 'daily', label: 'Daily', icon: 'mdi mdi-calendar-today' },
  { value: 'weekday', label: 'Every weekday', icon: 'mdi mdi-calendar-week' },
  { value: 'weekly', label: 'Weekly', icon: 'mdi mdi-calendar-week' },
  { value: 'monthly', label: 'Monthly', icon: 'mdi mdi-calendar-month' },
  { value: 'yearly', label: 'Yearly', icon: 'mdi mdi-calendar' },
];

const WEEKDAY_OPTIONS = [
  { label: 'Mon', iso: 1 },
  { label: 'Tue', iso: 2 },
  { label: 'Wed', iso: 3 },
  { label: 'Thu', iso: 4 },
  { label: 'Fri', iso: 5 },
  { label: 'Sat', iso: 6 },
  { label: 'Sun', iso: 7 },
] as const;

const MONTH_OPTIONS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const WEEK_OF_MONTH_OPTIONS = [
  { value: -1, label: 'Last' },
  { value: 1, label: '1st' },
  { value: 2, label: '2nd' },
  { value: 3, label: '3rd' },
  { value: 4, label: '4th' },
];

interface TaskRecurrencePickerProps {
  rule: RecurrenceRule | null | undefined;
  onChange: (rule: RecurrenceRuleInput) => void;
  onDelete?: () => void;
  readOnly?: boolean;
}

function emptyRule(): RecurrenceRuleInput {
  return {
    rule_type: 'weekly',
    interval: 1,
    weekdays: null,
    day_of_month: null,
    week_of_month: null,
    month: null,
    end_after_count: null,
    end_date: null,
    active: true,
  };
}

function ruleToInput(rule: RecurrenceRule | null | undefined): RecurrenceRuleInput {
  if (!rule) return emptyRule();
  return {
    rule_type: rule.rule_type,
    interval: rule.interval,
    weekdays: rule.weekdays,
    day_of_month: rule.day_of_month,
    week_of_month: rule.week_of_month,
    month: rule.month,
    end_after_count: rule.end_after_count,
    end_date: rule.end_date,
    active: rule.active,
  };
}

export function TaskRecurrencePicker({ rule, onChange, onDelete, readOnly = false }: TaskRecurrencePickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [draft, setDraft] = useState<RecurrenceRuleInput>(() => ruleToInput(rule));

  const openModal = () => {
    setDraft(ruleToInput(rule));
    setIsOpen(true);
  };

  const save = () => {
    onChange(draft);
    setIsOpen(false);
  };

  const handleDelete = () => {
    onDelete?.();
    setIsOpen(false);
  };

  const currentDescription = rule?.description || 'No recurrence';

  return (
    <div className="task-recurrence-picker">
      <div className="task-recurrence-picker__summary">
        <span className="task-recurrence-picker__description" title={currentDescription}>
          {currentDescription}
        </span>
        {!readOnly && (
          <Button
            icon="mdi mdi-pencil"
            aria-label={rule ? 'Edit recurrence' : 'Add recurrence'}
            size="xs"
            variant="ghost"
            onClick={openModal}
          />
        )}
      </div>

      <Modal
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        title={rule ? 'Edit recurrence' : 'Add recurrence'}
        size="sm"
        footer={
          <div className="task-recurrence-picker__footer">
            <div className="task-recurrence-picker__footer-actions">
              {rule && onDelete && (
                <Button variant="danger" size="sm" onClick={handleDelete}>
                  Remove
                </Button>
              )}
              <div className="task-recurrence-picker__footer-spacer" />
              <Button variant="ghost" size="sm" onClick={() => setIsOpen(false)}>
                Cancel
              </Button>
              <Button variant="primary" size="sm" onClick={save}>
                Save
              </Button>
            </div>
          </div>
        }
      >
        <div className="task-recurrence-picker__form">
          <span className="task-recurrence-picker__label">Repeat</span>
          <SelectionButton
            options={RULE_TYPES.map((t) => ({ value: t.value, icon: t.icon, label: t.label }))}
            value={draft.rule_type}
            onChange={(value) =>
              setDraft((prev) => ({
                ...prev,
                rule_type: value as RecurrenceRuleInput['rule_type'],
                weekdays: value === 'weekday' ? [1, 2, 3, 4, 5] : null,
                day_of_month: null,
                week_of_month: null,
                month: null,
              }))
            }
            size="sm"
          />

          {draft.rule_type !== 'weekday' && (
            <div className="task-recurrence-picker__field">
              <TextField
                type="number"
                label="Interval"
                min={1}
                value={draft.interval}
                onChange={(e) =>
                  setDraft((prev) => ({ ...prev, interval: Math.max(1, parseInt(e.target.value, 10) || 1) }))
                }
                size="sm"
              />
              <span className="task-recurrence-picker__interval-hint">
                {draft.rule_type === 'daily' && 'days'}
                {draft.rule_type === 'weekly' && 'weeks'}
                {draft.rule_type === 'monthly' && 'months'}
                {draft.rule_type === 'yearly' && 'years'}
              </span>
            </div>
          )}

          {draft.rule_type === 'weekly' && (
            <div className="task-recurrence-picker__field">
              <span className="task-recurrence-picker__label">On days</span>
              <div className="task-recurrence-picker__weekdays" role="group" aria-label="Weekdays">
                {WEEKDAY_OPTIONS.map((day) => {
                  const selected = (draft.weekdays ?? []).includes(day.iso);
                  return (
                    <button
                      key={day.iso}
                      type="button"
                      className={`task-recurrence-picker__weekday ${selected ? 'task-recurrence-picker__weekday--selected' : ''}`}
                      aria-pressed={selected}
                      aria-label={day.label}
                      onClick={() =>
                        setDraft((prev) => {
                          const current = new Set(prev.weekdays ?? []);
                          if (current.has(day.iso)) current.delete(day.iso);
                          else current.add(day.iso);
                          return { ...prev, weekdays: Array.from(current).sort((a, b) => a - b) };
                        })
                      }
                    >
                      {day.label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {draft.rule_type === 'monthly' && (
            <>
              <div className="task-recurrence-picker__field">
                <TextField
                  type="number"
                  label="Day of month"
                  min={1}
                  max={31}
                  placeholder="e.g. 15"
                  value={draft.day_of_month ?? ''}
                  onChange={(e) => {
                    const val = e.target.value === '' ? null : Math.min(31, Math.max(1, parseInt(e.target.value, 10) || 1));
                    setDraft((prev) => ({ ...prev, day_of_month: val, week_of_month: null, weekdays: null }));
                  }}
                  size="sm"
                />
              </div>

              <div className="task-recurrence-picker__field">
                <span className="task-recurrence-picker__label">Or on the</span>
                <div className="task-recurrence-picker__row">
                  <select
                    className="task-recurrence-picker__select"
                    aria-label="Week of month"
                    value={draft.week_of_month ?? ''}
                    onChange={(e) =>
                      setDraft((prev) => ({
                        ...prev,
                        week_of_month: e.target.value === '' ? null : parseInt(e.target.value, 10),
                        day_of_month: e.target.value === '' ? prev.day_of_month : null,
                        weekdays: e.target.value === '' ? prev.weekdays : (prev.weekdays?.length ? [prev.weekdays[0]] : [1]),
                      }))
                    }
                  >
                    <option value="">—</option>
                    {WEEK_OF_MONTH_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                  <div className="task-recurrence-picker__weekdays task-recurrence-picker__weekdays--compact">
                    {WEEKDAY_OPTIONS.map((day) => {
                      const selected = (draft.weekdays ?? []).includes(day.iso);
                      return (
                        <button
                          key={day.iso}
                          type="button"
                          className={`task-recurrence-picker__weekday ${selected ? 'task-recurrence-picker__weekday--selected' : ''}`}
                          aria-pressed={selected}
                          aria-label={day.label}
                          onClick={() =>
                            setDraft((prev) => ({
                              ...prev,
                              weekdays: [day.iso],
                              week_of_month: prev.week_of_month ?? 1,
                              day_of_month: null,
                            }))
                          }
                        >
                          {day.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            </>
          )}

          {draft.rule_type === 'yearly' && (
            <div className="task-recurrence-picker__row">
              <div className="task-recurrence-picker__field">
                <label className="task-recurrence-picker__label" htmlFor="recurrence-month">
                  Month
                </label>
                <select
                  id="recurrence-month"
                  className="task-recurrence-picker__select"
                  aria-label="Month"
                  value={draft.month ?? ''}
                  onChange={(e) =>
                    setDraft((prev) => ({ ...prev, month: e.target.value === '' ? null : parseInt(e.target.value, 10) }))
                  }
                >
                  <option value="">—</option>
                  {MONTH_OPTIONS.map((name, idx) => (
                    <option key={idx + 1} value={idx + 1}>
                      {name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="task-recurrence-picker__field">
                <TextField
                  type="number"
                  label="Day"
                  min={1}
                  max={31}
                  value={draft.day_of_month ?? ''}
                  onChange={(e) => {
                    const val = e.target.value === '' ? null : Math.min(31, Math.max(1, parseInt(e.target.value, 10) || 1));
                    setDraft((prev) => ({ ...prev, day_of_month: val }));
                  }}
                  size="sm"
                />
              </div>
            </div>
          )}

          <div className="task-recurrence-picker__end-section">
            <span className="task-recurrence-picker__label">End</span>
            <div className="task-recurrence-picker__row">
              <TextField
                type="number"
                label="After occurrences"
                min={1}
                placeholder="∞"
                value={draft.end_after_count ?? ''}
                onChange={(e) =>
                  setDraft((prev) => ({
                    ...prev,
                    end_after_count: e.target.value === '' ? null : Math.max(1, parseInt(e.target.value, 10) || 1),
                  }))
                }
                size="sm"
              />
              <TextField
                type="date"
                label="By date"
                value={draft.end_date ?? ''}
                onChange={(e) =>
                  setDraft((prev) => ({ ...prev, end_date: e.target.value || null }))
                }
                size="sm"
              />
            </div>
          </div>

          <div className="task-recurrence-picker__field task-recurrence-picker__field--inline">
            <ToggleSwitch
              checked={draft.active}
              onChange={(checked) => setDraft((prev) => ({ ...prev, active: checked }))}
              leftLabel="Paused"
              rightLabel="Active"
            />
          </div>
        </div>
      </Modal>
    </div>
  );
}
