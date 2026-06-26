/**
 * ExportPageModal - Modal for exporting one or more nodes
 *
 * Improvements:
 * - Live HTML preview for all formats (including PDF)
 * - Quick presets: Casual, Technical, Book
 * - Node name shown in title
 * - Batch export support (multiple node UUIDs)
 * - Dark mode toggle
 */
import { useState, useCallback, useEffect, useMemo } from 'react';
import { useCopiedState } from '@/hooks/useCopiedState';
import { useExportSettingsStore } from '@/stores';
import { useShallow } from 'zustand/react/shallow';
import { Modal } from '@/components/ui/Modal';
import { copyToClipboard } from '@/utils/clipboardManager';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { SelectionButton } from '@/components/ui/SelectionButton';
import { ButtonWithPanel, BooleanToggle, Icon } from '@/components/ui';
import api from '@/api/client';
import { nodeNameToText } from '@/features/queries';
import { downloadBlob } from '@/utils/download';
import QRCode from 'qrcode';
import { getExportFormat, formatHasHtmlOptions, getExportExtension, getRegisteredExportFormats } from './exportFormatRegistry';
import {
  startExportJob,
  startSingleExportJob,
  pollExportJob,
  fetchExportResult,
} from '@/api/exportJobs';
import './registerExportFormats';
import './ExportPageModal.css';

import type { ExportFormat, ExportLayout, ExportStyle, ExportProperties, ExportDensity, ExportNumbering, ExportMeasure, ExportDoctype, ExportLinkStyle, ExportThemeMode, ExportPageSize, ExportPreset } from '@/stores/exportSettingsStore';

export interface ExportPageModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Single node UUID (legacy) */
  nodeUuid?: string;
  /** Multiple node UUIDs for batch export */
  nodeUuids?: string[];
  /** Optional node name for the modal title */
  nodeName?: string;
  /** Optional node names for batch export */
  nodeNames?: string[];
}

export function ExportPageModal({ isOpen, onClose, nodeUuid, nodeUuids, nodeName }: ExportPageModalProps) {
  const {
    format, setFormat,
    layout, setLayout,
    style, setStyle,
    properties, setProperties,
    density, setDensity,
    numbering, setNumbering,
    measure, setMeasure,
    doctype, setDoctype,
    sectionBreak, setSectionBreak,
    formatting, setFormatting,
    showUuid, setShowUuid,
    linkStyle, setLinkStyle,
    cssOverrides, setCssOverrides,
    themeMode, setThemeMode,
    coverPage, setCoverPage,
    pageSize, setPageSize,
    includeChildPages, setIncludeChildPages,
    applyPreset,
  } = useExportSettingsStore(
    useShallow((s) => ({
      format: s.format, setFormat: s.setFormat,
      layout: s.layout, setLayout: s.setLayout,
      style: s.style, setStyle: s.setStyle,
      properties: s.properties, setProperties: s.setProperties,
      density: s.density, setDensity: s.setDensity,
      numbering: s.numbering, setNumbering: s.setNumbering,
      measure: s.measure, setMeasure: s.setMeasure,
      doctype: s.doctype, setDoctype: s.setDoctype,
      sectionBreak: s.sectionBreak, setSectionBreak: s.setSectionBreak,
      formatting: s.formatting, setFormatting: s.setFormatting,
      showUuid: s.showUuid, setShowUuid: s.setShowUuid,
      linkStyle: s.linkStyle, setLinkStyle: s.setLinkStyle,
      cssOverrides: s.cssOverrides, setCssOverrides: s.setCssOverrides,
      themeMode: s.themeMode, setThemeMode: s.setThemeMode,
      coverPage: s.coverPage, setCoverPage: s.setCoverPage,
      pageSize: s.pageSize, setPageSize: s.setPageSize,
      includeChildPages: s.includeChildPages, setIncludeChildPages: s.setIncludeChildPages,
      applyPreset: s.applyPreset,
    }))
  );

  const [previewContent, setPreviewContent] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, triggerCopy] = useCopiedState();
  const [downloading, setDownloading] = useState(false);
  const [qrModalOpen, setQrModalOpen] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [qrError, setQrError] = useState<string | null>(null);
  const [qrGenerating, setQrGenerating] = useState(false);
  const [htmlViewMode, setHtmlViewMode] = useState<'preview' | 'source'>('preview');
  const [pdfPreviewUrl, setPdfPreviewUrl] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const effectiveNodeUuids = useMemo(() => {
    if (nodeUuids && nodeUuids.length > 0) return nodeUuids;
    if (nodeUuid) return [nodeUuid];
    return [];
  }, [nodeUuid, nodeUuids]);

  const isBatch = effectiveNodeUuids.length > 1;

  const activePreset: ExportPreset | 'custom' = useMemo(() => {
    const current = { style, density, measure, numbering, doctype, sectionBreak, layout, themeMode, coverPage };
    const presets: Record<ExportPreset, typeof current> = {
      casual: { style: 'casual', density: 'comfortable', measure: 'readable', numbering: 'none', doctype: 'article', sectionBreak: false, layout: 'outline', themeMode: 'light', coverPage: false },
      editorial: { style: 'editorial', density: 'comfortable', measure: 'readable', numbering: 'none', doctype: 'article', sectionBreak: false, layout: 'outline', themeMode: 'light', coverPage: true },
      technical: { style: 'technical', density: 'compact', measure: 'full', numbering: 'hierarchical', doctype: 'report', sectionBreak: true, layout: 'flat', themeMode: 'light', coverPage: true },
      book: { style: 'book', density: 'comfortable', measure: 'book', numbering: 'hierarchical', doctype: 'book', sectionBreak: true, layout: 'flat', themeMode: 'light', coverPage: true },
      legal: { style: 'technical', density: 'compact', measure: 'full', numbering: 'legal', doctype: 'legal', sectionBreak: false, layout: 'outline', themeMode: 'light', coverPage: false },
      academic: { style: 'editorial', density: 'comfortable', measure: 'readable', numbering: 'none', doctype: 'academic', sectionBreak: false, layout: 'outline', themeMode: 'light', coverPage: false },
    };
    for (const [key, values] of Object.entries(presets)) {
      const match = Object.entries(values).every(([k, v]) => current[k as keyof typeof current] === v);
      if (match) return key as ExportPreset;
    }
    return 'custom';
  }, [style, density, measure, numbering, doctype, sectionBreak, layout, themeMode, coverPage]);

  const handleFormatChange = useCallback((f: ExportFormat) => {
    setFormat(f);
  }, [setFormat]);

  // Fetch preview whenever settings change.
  // Exports are asynchronous: we start a job, poll until completion, then
  // download the result from the job's download endpoint.
  useEffect(() => {
    if (!isOpen || effectiveNodeUuids.length === 0) {
      return;
    }

    let cancelled = false;
    const debounceTimer = window.setTimeout(async () => {
      if (cancelled) return;
      setLoading(true);
      setError(null);

      const params: Record<string, unknown> = {
        include_children: true,
        layout,
        formatting,
        style,
        properties,
        density,
        numbering,
        measure,
        doctype,
        section_break: sectionBreak,
        show_uuid: showUuid,
        link_style: linkStyle,
        theme_mode: themeMode,
        cover_page: coverPage,
        page_size: pageSize,
        include_child_pages: includeChildPages,
      };

      try {
        if (format === 'opml') {
          if (effectiveNodeUuids.length !== 1) {
            throw new Error('OPML export only supports a single node');
          }
          const { data } = await api.get<string>(`/export/opml/${effectiveNodeUuids[0]}`, {
            responseType: 'text',
          });
          setPreviewContent(data);
          return;
        }

        const previewFormat = format === 'pdf' ? 'pdf' : formatHasHtmlOptions(format) ? 'html' : format;
        const jobUuid = isBatch
          ? await startExportJob({ nodeUuids: effectiveNodeUuids, params: { ...params, format: previewFormat } })
          : await startSingleExportJob(effectiveNodeUuids[0], { ...params, format: previewFormat });

        const job = await pollExportJob(jobUuid, {
          onStatus: (j) => {
            if (!cancelled) {
              // Surface user-visible progress text only when it changes.
              if (j.status_text) {
                setError((prev) => (prev?.startsWith(j.status_text) ? prev : null));
              }
            }
          },
        });

        if (cancelled) return;

        if (format === 'pdf') {
          const { data } = await fetchExportResult<Blob>(job.job_uuid, 'blob');
          const blob = data instanceof Blob ? data : new Blob([data as BlobPart], { type: 'application/pdf' });
          const url = URL.createObjectURL(blob);
          setPdfPreviewUrl((prev) => {
            if (prev) URL.revokeObjectURL(prev);
            return url;
          });
        } else {
          const { data } = await fetchExportResult<string>(job.job_uuid, 'text');
          setPreviewContent(data as string);
        }
      } catch (e: unknown) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Failed to load preview');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 300);

    return () => {
      cancelled = true;
      window.clearTimeout(debounceTimer);
    };
  }, [isOpen, format, layout, formatting, style, properties, density, numbering, measure, doctype, sectionBreak, showUuid, linkStyle, themeMode, coverPage, pageSize, includeChildPages, effectiveNodeUuids, isBatch]);

  // Revoke PDF object URL when the modal closes or format changes.
  useEffect(() => {
    return () => {
      setPdfPreviewUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
    };
  }, [format, isOpen]);

  // For Markdown/Text/JSON tabs, show plain-text body content.
  // For HTML/PDF tab, show the raw HTML or inject CSS overrides.
  const displayContent = useMemo(() => {
    if (!previewContent) return '';
    if (!formatHasHtmlOptions(format)) {
      return previewContent;
    }
    if (cssOverrides.trim()) {
      const styleTag = `<style>\n${cssOverrides.trim()}\n</style>`;
      if (previewContent.includes('</head>')) {
        return previewContent.replace('</head>', `${styleTag}\n</head>`);
      }
    }
    return previewContent;
  }, [format, previewContent, cssOverrides]);

  const handleCopy = useCallback(() => {
    const text = displayContent || previewContent;
    if (!text) return;
    copyToClipboard(text).then(() => {
      triggerCopy();
    });
  }, [displayContent, previewContent, triggerCopy]);

  const handleDownload = useCallback(async () => {
    setDownloading(true);
    setError(null);
    try {
      if (format === 'opml') {
        if (effectiveNodeUuids.length !== 1) {
          throw new Error('OPML export only supports a single node');
        }
        const { data } = await api.get<string>(`/export/opml/${effectiveNodeUuids[0]}`, {
          responseType: 'text',
        });
        downloadBlob(new Blob([data], { type: 'text/x-opml+xml' }), 'export.opml');
        return;
      }

      const baseParams: Record<string, unknown> = {
        format,
        include_children: true,
        layout,
        formatting,
        style,
        properties,
        density,
        numbering,
        measure,
        doctype,
        section_break: sectionBreak,
        show_uuid: showUuid,
        link_style: linkStyle,
        theme_mode: themeMode,
        cover_page: coverPage,
        page_size: pageSize,
        include_child_pages: includeChildPages,
      };

      if (getExportFormat(format)?.format === 'pdf' && cssOverrides.trim()) {
        // Preserve custom-CSS path: fetch HTML via async job, inject overrides,
        // then render PDF through the direct render endpoint.
        const htmlParams = { ...baseParams, format: 'html' };
        const htmlJobUuid = isBatch
          ? await startExportJob({ nodeUuids: effectiveNodeUuids, params: htmlParams })
          : await startSingleExportJob(effectiveNodeUuids[0], htmlParams);
        const htmlJob = await pollExportJob(htmlJobUuid);
        const { data: html } = await fetchExportResult<string>(htmlJob.job_uuid, 'text');
        const styleTag = `<style>\n${cssOverrides.trim()}\n</style>`;
        const htmlWithCss = html.includes('</head>')
          ? html.replace('</head>', `${styleTag}\n</head>`)
          : styleTag + '\n' + html;
        const pdfResponse = await api.post('/export/render-pdf', { html: htmlWithCss }, { responseType: 'blob' });
        downloadBlob(pdfResponse.data as Blob, 'export.pdf');
        return;
      }

      const jobUuid = isBatch
        ? await startExportJob({ nodeUuids: effectiveNodeUuids, params: baseParams })
        : await startSingleExportJob(effectiveNodeUuids[0], baseParams);
      const job = await pollExportJob(jobUuid);
      const { data, headers } = await fetchExportResult<Blob>(job.job_uuid, 'blob');
      const blob = data instanceof Blob ? data : new Blob([data as BlobPart], { type: getExportFormat(format)?.mimeType ?? 'application/octet-stream' });

      const disposition = headers['content-disposition'] ?? undefined;
      let filename = format === 'pdf' ? 'export.pdf' : `export.${getExportExtension(format)}`;
      if (disposition) {
        const match = disposition.match(/filename="?([^"]+)"?/);
        if (match) filename = match[1];
      }
      downloadBlob(blob, filename);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Download failed');
    } finally {
      setDownloading(false);
    }
  }, [format, layout, formatting, style, properties, density, numbering, measure, doctype, sectionBreak, showUuid, linkStyle, themeMode, coverPage, pageSize, includeChildPages, effectiveNodeUuids, isBatch, cssOverrides]);

  const handleGenerateQr = useCallback(async () => {
    const text = displayContent || previewContent;
    if (!text) return;
    setQrGenerating(true);
    setQrError(null);
    try {
      const dataUrl = await QRCode.toDataURL(text, {
        width: 256,
        margin: 2,
        color: {
          dark: '#000000',
          light: '#ffffff',
        },
      });
      setQrDataUrl(dataUrl);
      setQrModalOpen(true);
    } catch (e: unknown) {
      setQrError(e instanceof Error ? e.message : 'Failed to generate QR code');
      setQrModalOpen(true);
    } finally {
      setQrGenerating(false);
    }
  }, [displayContent, previewContent]);

  const title = useMemo(() => {
    if (isBatch) {
      const count = effectiveNodeUuids.length;
      return `Export ${count} nodes`;
    }
    const plainName = nodeName ? nodeNameToText(nodeName) : '';
    return plainName ? `Export: ${plainName}` : 'Export';
  }, [isBatch, effectiveNodeUuids.length, nodeName]);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      size="lg"
      footer={
        <div className="export-modal__footer">
          <ButtonWithPanel
            icon={"mdi mdi-cog"}
            size="sm"
            panelPosition="top"
            panelAlignment="start"
            panelWidth={340}
            showCloseButton={false}
            panelClassName="export-modal__options-panel"
            usePortal={true}
          >
            <div className="visibility-panel-content">
              {/* Presets */}
              <div className="visibility-option">
                <div className="export-presets">
                  <div className="export-presets__header">
                    <span className="export-presets__label">Quick preset</span>
                    <span className="export-presets__active">{activePreset === 'custom' ? 'Custom' : activePreset.charAt(0).toUpperCase() + activePreset.slice(1)}</span>
                  </div>
                  <div className="export-presets__row">
                    {[
                      { key: 'casual', icon: 'mdi-note-text-outline', title: 'Casual note (Obsidian-like)' },
                      { key: 'editorial', icon: 'mdi-feather', title: 'Editorial prose (serif, elegant)' },
                      { key: 'technical', icon: 'mdi-file-document-outline', title: 'Technical document (LaTeX-like)' },
                      { key: 'book', icon: 'mdi-book-open-variant', title: 'Long-form book' },
                      { key: 'legal', icon: 'mdi-scale-balance', title: 'Legal memo' },
                      { key: 'academic', icon: 'mdi-school', title: 'Academic paper' },
                    ].map((p) => (
                      <button
                        key={p.key}
                        type="button"
                        className={`export-preset-btn${activePreset === p.key ? ' export-preset-btn--active' : ''}`}
                        onClick={() => applyPreset(p.key as ExportPreset)}
                        title={p.title}
                      >
                        <Icon path={`mdi ${p.icon}`} className="export-preset-btn__icon" />
                        <span className="export-preset-btn__text">{p.key.charAt(0).toUpperCase() + p.key.slice(1)}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="export-options-section">
                <span className="export-options-section__label">Theme</span>
                {formatHasHtmlOptions(format) && (
                  <div className="visibility-option">
                    <SelectionButton
                      size="sm"
                      label="Style"
                      description="Visual theme for the exported document"
                      labelPosition="left"
                      options={[
                        { value: 'modern', icon: "mdi mdi-text-short", label: 'Modern' },
                        { value: 'casual', icon: "mdi mdi-note-text-outline", label: 'Casual' },
                        { value: 'editorial', icon: "mdi mdi-feather", label: 'Editorial' },
                        { value: 'technical', icon: "mdi mdi-book-open-page-variant", label: 'Technical' },
                        { value: 'book', icon: "mdi mdi-book", label: 'Book' },
                      ]}
                      value={style}
                      onChange={(v) => setStyle(v as ExportStyle)}
                    />
                  </div>
                )}
                {formatHasHtmlOptions(format) && (
                  <div className="visibility-option">
                    <SelectionButton
                      size="sm"
                      label="Theme mode"
                      description="Light or dark background for the export"
                      labelPosition="left"
                      options={[
                        { value: 'light', icon: "mdi mdi-white-balance-sunny", label: 'Light' },
                        { value: 'dark', icon: "mdi mdi-weather-night", label: 'Dark' },
                      ]}
                      value={themeMode}
                      onChange={(v) => setThemeMode(v as ExportThemeMode)}
                    />
                  </div>
                )}
              </div>

              <div className="export-options-section">
                <span className="export-options-section__label">Page</span>
                <div className="visibility-option">
                  <SelectionButton
                    size="sm"
                    label="Layout"
                    description="Outline preserves hierarchy, flat lists all content"
                    labelPosition="left"
                    options={[
                      { value: 'outline', icon: "mdi mdi-file-tree", label: 'Outline' },
                      { value: 'flat', icon: "mdi mdi-file-document-outline", label: 'Flat' },
                    ]}
                    value={layout}
                    onChange={(v) => setLayout(v as ExportLayout)}
                  />
                </div>
                {formatHasHtmlOptions(format) && (
                  <div className="visibility-option">
                    <SelectionButton
                      size="sm"
                      label="Page size"
                      description="Paper size for PDF output"
                      labelPosition="left"
                      options={[
                        { value: 'a4', icon: "mdi mdi-file-document-outline", label: 'A4' },
                        { value: 'letter', icon: "mdi mdi-file-document-outline", label: 'Letter' },
                        { value: 'legal', icon: "mdi mdi-file-document-outline", label: 'Legal' },
                      ]}
                      value={pageSize}
                      onChange={(v) => setPageSize(v as ExportPageSize)}
                    />
                  </div>
                )}
                {formatHasHtmlOptions(format) && (
                  <div className="visibility-option">
                    <BooleanToggle
                      size="sm"
                      label="Cover page"
                      description="Render the title as a standalone title page"
                      labelPosition="left"
                      checked={coverPage}
                      onChange={(e) => setCoverPage(e.target.checked)}
                    />
                  </div>
                )}
                {formatHasHtmlOptions(format) && (
                  <div className="visibility-option">
                    <BooleanToggle
                      size="sm"
                      label="Section page breaks"
                      description="Force h1/h2 headings to start on a new page"
                      labelPosition="left"
                      checked={sectionBreak}
                      onChange={(e) => setSectionBreak(e.target.checked)}
                    />
                  </div>
                )}
                <div className="visibility-option">
                  <BooleanToggle
                    size="sm"
                    label="Include child pages"
                    description="Export nested pages as sections"
                    labelPosition="left"
                    checked={includeChildPages}
                    onChange={(e) => setIncludeChildPages(e.target.checked)}
                  />
                </div>
              </div>

              <div className="export-options-section">
                <span className="export-options-section__label">Content</span>
                <div className="visibility-option">
                  <SelectionButton
                    size="sm"
                    label="Formatting"
                    description="Apply rich text styles or export plain text"
                    labelPosition="left"
                    options={[
                      { value: 'true', icon: "mdi mdi-format-text", label: 'Formatted' },
                      { value: 'false', icon: "mdi mdi-code-braces", label: 'Plain' },
                    ]}
                    value={formatting ? 'true' : 'false'}
                    onChange={(v) => setFormatting(v === 'true')}
                  />
                </div>
                <div className="visibility-option">
                  <SelectionButton
                    size="sm"
                    label="Properties"
                    description="Which nodes to show properties for"
                    labelPosition="left"
                    options={[
                      { value: 'none', icon: "mdi mdi-tag-off", label: 'None' },
                      { value: 'main', icon: "mdi mdi-tag-outline", label: 'Main node' },
                      { value: 'all', icon: "mdi mdi-tag-multiple-outline", label: 'All nodes' },
                    ]}
                    value={properties}
                    onChange={(v) => setProperties(v as ExportProperties)}
                  />
                </div>
                <div className="visibility-option">
                  <BooleanToggle
                    size="sm"
                    label="Show UUID"
                    description="Include the node UUID as a property in the export"
                    labelPosition="left"
                    checked={showUuid}
                    onChange={(e) => setShowUuid(e.target.checked)}
                  />
                </div>
                <div className="visibility-option">
                  <SelectionButton
                    size="sm"
                    label="Links"
                    description="Show raw UUIDs in links or only the display text"
                    labelPosition="left"
                    options={[
                      { value: 'raw', icon: "mdi mdi-link-variant", label: 'Raw' },
                      { value: 'text', icon: "mdi mdi-link-off", label: 'Text only' },
                    ]}
                    value={linkStyle}
                    onChange={(v) => setLinkStyle(v as ExportLinkStyle)}
                  />
                </div>
              </div>

              {formatHasHtmlOptions(format) && (
                <div className="export-options-section">
                  <button
                    type="button"
                    className="export-options-section__toggle"
                    onClick={() => setAdvancedOpen((o) => !o)}
                  >
                    <span>Advanced</span>
                    <Icon path={`mdi ${advancedOpen ? 'mdi-chevron-up' : 'mdi-chevron-down'}`} />
                  </button>
                  {advancedOpen && (
                    <>
                      <div className="visibility-option">
                        <SelectionButton
                          size="sm"
                          label="Density"
                          description="Spacing between elements in the output"
                          labelPosition="left"
                          options={[
                            { value: 'comfortable', icon: "mdi mdi-view-headline", label: 'Comfortable' },
                            { value: 'compact', icon: "mdi mdi-view-compact", label: 'Compact' },
                          ]}
                          value={density}
                          onChange={(v) => setDensity(v as ExportDensity)}
                        />
                      </div>
                      <div className="visibility-option">
                        <SelectionButton
                          size="sm"
                          label="Measure"
                          description="Page width and column layout"
                          labelPosition="left"
                          options={[
                            { value: 'full', icon: "mdi mdi-arrow-expand-horizontal", label: 'Full' },
                            { value: 'readable', icon: "mdi mdi-text", label: 'Readable' },
                            { value: 'book', icon: "mdi mdi-book", label: 'Book' },
                            { value: 'two-column', icon: "mdi mdi-view-column", label: '2-column' },
                          ]}
                          value={measure}
                          onChange={(v) => setMeasure(v as ExportMeasure)}
                        />
                      </div>
                      <div className="visibility-option">
                        <SelectionButton
                          size="sm"
                          label="Numbering"
                          description="Add hierarchical numbers to headings"
                          labelPosition="left"
                          options={[
                            { value: 'none', icon: "mdi mdi-format-list-bulleted", label: 'None' },
                            { value: 'hierarchical', icon: "mdi mdi-format-list-numbered-rtl", label: 'Hierarchical' },
                            { value: 'legal', icon: "mdi mdi-format-list-numbered", label: 'Legal' },
                            { value: 'appendix', icon: "mdi mdi-format-letter-case-upper", label: 'Appendix' },
                          ]}
                          value={numbering}
                          onChange={(v) => setNumbering(v as ExportNumbering)}
                        />
                      </div>
                      <div className="visibility-option">
                        <SelectionButton
                          size="sm"
                          label="Document type"
                          description="Semantic document behaviour: page breaks, spacing, TOC"
                          labelPosition="left"
                          options={[
                            { value: 'none', icon: "mdi mdi-minus", label: 'None' },
                            { value: 'article', icon: "mdi mdi-newspaper", label: 'Article' },
                            { value: 'report', icon: "mdi mdi-file-chart-outline", label: 'Report' },
                            { value: 'book', icon: "mdi mdi-book", label: 'Book' },
                            { value: 'legal', icon: "mdi mdi-scale-balance", label: 'Legal' },
                            { value: 'academic', icon: "mdi mdi-school", label: 'Academic' },
                          ]}
                          value={doctype}
                          onChange={(v) => setDoctype(v as ExportDoctype)}
                        />
                      </div>
                      {formatHasHtmlOptions(format) && (
                        <div className="visibility-option">
                          <label className="export-modal__label" htmlFor="export-css-overrides">
                            Custom CSS overrides{' '}
                            <span className="export-modal__label-hint">(preview only)</span>
                          </label>
                          <textarea
                            id="export-css-overrides"
                            className="export-modal__css-textarea"
                            value={cssOverrides}
                            onChange={(e) => setCssOverrides(e.target.value)}
                            placeholder={`body { font-family: Georgia, serif; }\n@media print { .sidebar { display: none; } }`}
                            spellCheck={false}
                            rows={4}
                          />
                          <p className="export-modal__pdf-hint">
                            CSS overrides are applied to the live preview only.
                          </p>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          </ButtonWithPanel>
          <div className="export-modal__footer-actions">
            <Button variant="ghost" onClick={onClose} disabled={downloading}>
              Cancel
            </Button>
            {format !== 'pdf' && (
              <Button
                variant="ghost"
                icon={qrGenerating ? undefined : "mdi mdi-qrcode"}
                onClick={handleGenerateQr}
                disabled={loading || !previewContent || downloading || qrGenerating}
              >
                {qrGenerating ? <Spinner size="sm" label="Generating…" /> : 'QR Code'}
              </Button>
            )}
            <Button
              variant="ghost"
              icon={copied ? "mdi mdi-check" : "mdi mdi-content-copy"}
              onClick={handleCopy}
              disabled={loading || !previewContent || downloading}
            >
              {copied ? 'Copied!' : 'Copy'}
            </Button>
            <Button
              variant="primary"
              icon={"mdi mdi-download"}
              onClick={handleDownload}
              disabled={downloading || loading}
            >
              {downloading ? <Spinner size="sm" label="Downloading…" /> : 'Download'}
            </Button>
          </div>
        </div>
      }
    >
      <div className="export-modal__body">
        {/* Format tabs */}
        <div className="export-modal__tabs" role="tablist" aria-label="Export format">
          {getRegisteredExportFormats().map((def) => (
            <button
              key={def.format}
              role="tab"
              aria-selected={format === def.format}
              className={`export-modal__tab${
                format === def.format ? ' export-modal__tab--active' : ''
              }`}
              onClick={() => handleFormatChange(def.format as ExportFormat)}
            >
              {def.label}
            </button>
          ))}
        </div>

        {/* Preview area */}
        <div className="export-modal__preview-wrap">
          {error && (
            <div className="export-modal__error">{error}</div>
          )}

          {!formatHasHtmlOptions(format) ? (
            <textarea
              className={`export-modal__preview${loading ? ' export-modal__preview--loading' : ''}`}
              readOnly
              value={displayContent}
              spellCheck={false}
              aria-label={`${format} preview`}
            />
          ) : (
            <>
              {format === 'html' && (
                <div className="export-modal__view-toggle">
                  <button
                    type="button"
                    className={`export-modal__view-btn${htmlViewMode === 'preview' ? ' export-modal__view-btn--active' : ''}`}
                    onClick={() => setHtmlViewMode('preview')}
                  >
                    Preview
                  </button>
                  <button
                    type="button"
                    className={`export-modal__view-btn${htmlViewMode === 'source' ? ' export-modal__view-btn--active' : ''}`}
                    onClick={() => setHtmlViewMode('source')}
                  >
                    Source
                  </button>
                </div>
              )}
              {format === 'pdf' && pdfPreviewUrl ? (
                <div className={`export-modal__iframe-wrap export-modal__iframe-wrap--pdf${loading ? ' export-modal__iframe-wrap--loading' : ''}`}>
                  <embed
                    className="export-modal__iframe"
                    title="PDF preview"
                    src={pdfPreviewUrl}
                    type="application/pdf"
                  />
                </div>
              ) : format === 'html' && htmlViewMode === 'source' ? (
                <textarea
                  className={`export-modal__preview${loading ? ' export-modal__preview--loading' : ''}`}
                  readOnly
                  value={displayContent}
                  spellCheck={false}
                  aria-label="HTML source"
                />
              ) : (
                <div className={`export-modal__iframe-wrap${loading ? ' export-modal__iframe-wrap--loading' : ''}`}>
                  {displayContent && (
                    <iframe
                      className="export-modal__iframe"
                      title="Export preview"
                      srcDoc={displayContent}
                      sandbox="allow-same-origin"
                    />
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <Modal
        isOpen={qrModalOpen}
        onClose={() => setQrModalOpen(false)}
        title="QR Code"
        size="sm"
      >
        <div className="export-modal__qr-content">
          {qrError ? (
            <div className="export-modal__qr-error">{qrError}</div>
          ) : qrDataUrl ? (
            <img
              src={qrDataUrl}
              alt="QR Code"
              className="export-modal__qr-image"
            />
          ) : (
            <Spinner size="md" label="Generating QR code…" />
          )}
        </div>
      </Modal>
    </Modal>
  );
}
