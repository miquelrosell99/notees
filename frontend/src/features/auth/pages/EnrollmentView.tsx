/**
 * EnrollmentView Component
 * 
 * Multi-step onboarding for new users after registration.
 * Asks for theme preference and default date format.
 */
import { useState, useEffect } from 'react';
import { useSettingsStore, applyTheme, DATE_FORMAT_OPTIONS } from '@/stores';
import type { ThemePreference, DateFormat } from '@/stores';
import { setSetting } from '@/features/workspace';
import { useNotifications } from '@/stores/notificationStore';
import { useReducedMotion } from '@/hooks';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import './EnrollmentView.css';

interface EnrollmentViewProps {
  onComplete: () => void;
}

type Step = 'welcome' | 'theme' | 'date-format' | 'done';
type AnimationPhase = 'entering' | 'active' | 'exiting';

export function EnrollmentView({ onComplete }: EnrollmentViewProps) {
  const [step, setStep] = useState<Step>('welcome');
  const [animationPhase, setAnimationPhase] = useState<AnimationPhase>('entering');
  // State
  const theme = useSettingsStore((s) => s.theme);
  const dateFormat = useSettingsStore((s) => s.dateFormat);
  // Actions
  const setTheme = useSettingsStore((s) => s.setTheme);
  const setDateFormat = useSettingsStore((s) => s.setDateFormat);
  const [selectedTheme, setSelectedTheme] = useState<ThemePreference>(theme);
  const [selectedDateFormat, setSelectedDateFormat] = useState<DateFormat>(dateFormat);
  const [isSaving, setIsSaving] = useState(false);
  const { error: notifyError } = useNotifications();
  const reducedMotion = useReducedMotion();

  // Trigger entering animation on mount and when step changes
  useEffect(() => {
    if (reducedMotion) {
      setAnimationPhase('active');
      return;
    }
    setAnimationPhase('entering');
    const timer = setTimeout(() => {
      setAnimationPhase('active');
    }, 50); // Small delay to trigger CSS animation
    return () => clearTimeout(timer);
  }, [step, reducedMotion]);

  const handleThemeSelect = (newTheme: ThemePreference) => {
    setSelectedTheme(newTheme);
    applyTheme(newTheme);
  };

  const transitionToStep = (nextStep: Step) => {
    if (reducedMotion) {
      setStep(nextStep);
      setAnimationPhase('active');
      return;
    }
    setAnimationPhase('exiting');
    setTimeout(() => {
      setStep(nextStep);
    }, 300); // Match CSS animation duration
  };

  const handleBack = () => {
    if (step === 'theme') transitionToStep('welcome');
    else if (step === 'date-format') transitionToStep('theme');
  };

  const handleNext = async () => {
    if (step === 'welcome') {
      transitionToStep('theme');
    } else if (step === 'theme') {
      setTheme(selectedTheme);
      transitionToStep('date-format');
    } else if (step === 'date-format') {
      setIsSaving(true);
      setDateFormat(selectedDateFormat);
      try {
        await Promise.all([
          setSetting('theme', selectedTheme),
          setSetting('date_format', selectedDateFormat),
          setSetting('enrollment_completed', true),
        ]);
      } catch {
        notifyError('Failed to save preferences', 'Your settings may not persist after refresh.');
      }
      setIsSaving(false);
      transitionToStep('done');
    } else if (step === 'done') {
      onComplete();
    }
  };

  const handleSkip = async () => {
    setIsSaving(true);
    try {
      await setSetting('enrollment_completed', true);
    } catch {
      notifyError('Failed to save enrollment status', 'Please refresh and try again.');
    }
    setIsSaving(false);
    onComplete();
  };

  const getStepNumber = () => {
    switch (step) {
      case 'welcome': return 0;
      case 'theme': return 1;
      case 'date-format': return 2;
      case 'done': return 3;
    }
  };

  return (
    <div className="enrollment">
      <div className="enrollment__container">
        <div className="enrollment__header">
          <h1 className="enrollment__logo">Notees</h1>
          <div className="enrollment__progress">
            {[0, 1, 2, 3].map((i) => (
              <div
                key={i}
                className={`enrollment__progress-dot ${i <= getStepNumber() ? 'enrollment__progress-dot--active' : ''}`}
              />
            ))}
          </div>
        </div>

        <Card className="enrollment__card" elevation="medium">
          <div className={`enrollment__step-container enrollment__step-container--${animationPhase}`}>
            {step === 'welcome' && (
              <div className="enrollment__step">
                <h2 className="enrollment__title">Welcome to Notees!</h2>
                <p className="enrollment__description">
                  Set your preferences to finish getting started.
                </p>
                <div className="enrollment__actions">
                  <Button variant="primary" size="lg" onClick={handleNext}>
                    Get Started
                  </Button>
                  <Button variant="ghost" size="sm" onClick={handleSkip}>
                    Skip setup
                  </Button>
                </div>
              </div>
              )}

            {step === 'theme' && (
              <div className="enrollment__step">
                <h2 className="enrollment__title">Choose your theme</h2>
                <p className="enrollment__description">
                  How do you prefer your workspace to look?
                </p>
                <div className="enrollment__options enrollment__theme-options">
                  <button
                    className={`enrollment__theme-card ${selectedTheme === 'light' ? 'enrollment__theme-card--selected' : ''}`}
                    onClick={() => handleThemeSelect('light')}
                  >
                    <div className="enrollment__theme-preview enrollment__theme-preview--light">
                      <div className="enrollment__theme-sidebar" />
                      <div className="enrollment__theme-content">
                        <div className="enrollment__theme-line" />
                        <div className="enrollment__theme-line enrollment__theme-line--short" />
                      </div>
                    </div>
                    <span className="enrollment__theme-label">Light</span>
                  </button>
                  <button
                    className={`enrollment__theme-card ${selectedTheme === 'dark' ? 'enrollment__theme-card--selected' : ''}`}
                    onClick={() => handleThemeSelect('dark')}
                  >
                    <div className="enrollment__theme-preview enrollment__theme-preview--dark">
                      <div className="enrollment__theme-sidebar" />
                      <div className="enrollment__theme-content">
                        <div className="enrollment__theme-line" />
                        <div className="enrollment__theme-line enrollment__theme-line--short" />
                      </div>
                    </div>
                    <span className="enrollment__theme-label">Dark</span>
                  </button>
                  <button
                    className={`enrollment__theme-card ${selectedTheme === 'system' ? 'enrollment__theme-card--selected' : ''}`}
                    onClick={() => handleThemeSelect('system')}
                  >
                    <div className="enrollment__theme-preview enrollment__theme-preview--system">
                      <div className="enrollment__theme-half enrollment__theme-half--light">
                        <div className="enrollment__theme-line" />
                      </div>
                      <div className="enrollment__theme-half enrollment__theme-half--dark">
                        <div className="enrollment__theme-line" />
                      </div>
                    </div>
                    <span className="enrollment__theme-label">System</span>
                  </button>
                </div>
                <div className="enrollment__actions">
                  <Button variant="primary" size="md" onClick={handleNext}>
                    Continue
                  </Button>
                  <Button variant="ghost" size="sm" onClick={handleBack}>
                    Back
                  </Button>
                </div>
              </div>
              )}

            {step === 'date-format' && (
              <div className="enrollment__step">
                <h2 className="enrollment__title">Date format</h2>
                <p className="enrollment__description">
                  Choose how dates appear in your daily and monthly notes.
                  You can change this per workspace later.
                </p>
                <div className="enrollment__options enrollment__date-options">
                  {DATE_FORMAT_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      className={`enrollment__date-card ${selectedDateFormat === option.value ? 'enrollment__date-card--selected' : ''}`}
                      onClick={() => setSelectedDateFormat(option.value)}
                    >
                      <span className="enrollment__date-example">{option.example}</span>
                      <span className="enrollment__date-label">{option.label}</span>
                    </button>
                  ))}
                </div>
                <div className="enrollment__actions">
                  <Button variant="primary" size="md" onClick={handleNext} disabled={isSaving}>
                    {isSaving ? 'Saving...' : 'Finish'}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={handleBack} disabled={isSaving}>
                    Back
                  </Button>
                </div>
              </div>
            )}

            {step === 'done' && (
              <div className="enrollment__step">
                <h2 className="enrollment__title">You're all set!</h2>
                <p className="enrollment__description">
                  Your preferences are saved. Create your first workspace to start taking notes.
                </p>
                <div className="enrollment__actions">
                  <Button variant="primary" size="lg" onClick={handleNext}>
                    Let's go
                  </Button>
                </div>
              </div>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}

export default EnrollmentView;
