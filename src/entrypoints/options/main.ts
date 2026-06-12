import {
  DEFAULT_SETTINGS,
  bgRgba,
  loadSettings,
  saveSettings,
  watchSettings,
  type SubtitleSettings,
} from '@/shared/settings';

const form = document.getElementById('form') as HTMLFormElement;
const previewCue = document.getElementById('previewCue') as HTMLSpanElement;
const preview = document.getElementById('preview') as HTMLDivElement;
const fontOut = document.getElementById('fontOut') as HTMLOutputElement;

function field(name: keyof SubtitleSettings): HTMLInputElement | HTMLSelectElement {
  return form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement;
}

function fillForm(s: SubtitleSettings): void {
  field('fontSizePct').value = String(s.fontSizePct);
  field('fontFamily').value = s.fontFamily;
  field('textColor').value = s.textColor;
  field('bgColor').value = s.bgColor;
  field('bgOpacity').value = String(s.bgOpacity);
  field('position').value = s.position;
  field('edgeStyle').value = s.edgeStyle;
  renderPreview(s);
}

function readForm(): SubtitleSettings {
  return {
    fontSizePct: Number(field('fontSizePct').value),
    fontFamily: field('fontFamily').value as SubtitleSettings['fontFamily'],
    textColor: field('textColor').value,
    bgColor: field('bgColor').value,
    bgOpacity: Number(field('bgOpacity').value),
    position: field('position').value as SubtitleSettings['position'],
    edgeStyle: field('edgeStyle').value as SubtitleSettings['edgeStyle'],
  };
}

function renderPreview(s: SubtitleSettings): void {
  fontOut.textContent = `${s.fontSizePct}%`;
  const previewHeight = preview.clientHeight || 280;
  previewCue.style.fontSize = `${(previewHeight * s.fontSizePct) / 100}px`;
  previewCue.style.fontFamily =
    s.fontFamily === 'sans-serif' ? 'system-ui, sans-serif' : s.fontFamily;
  previewCue.style.color = s.textColor;
  previewCue.style.background = bgRgba(s);
  previewCue.style.textShadow =
    s.edgeStyle === 'shadow'
      ? '0 0 4px rgba(0,0,0,.95), 0 1px 2px rgba(0,0,0,.9)'
      : s.edgeStyle === 'outline'
        ? '-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000'
        : 'none';
  previewCue.style.top = s.position === 'top' ? '6%' : 'auto';
  previewCue.style.bottom = s.position === 'bottom' ? '12%' : 'auto';
}

form.addEventListener('input', () => {
  const s = readForm();
  renderPreview(s);
  void saveSettings(s);
});

document.getElementById('reset')?.addEventListener('click', () => {
  fillForm(DEFAULT_SETTINGS);
  void saveSettings(DEFAULT_SETTINGS);
});

watchSettings(fillForm); // reflect changes made from the PiP window's A−/A+ buttons

void loadSettings().then(fillForm);
