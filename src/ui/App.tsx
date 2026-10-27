import imageModels from '../shared/image-models.json';
import {ChangeEvent, DragEvent, MouseEvent, useEffect, useMemo, useRef, useState} from 'react';

type ReferenceImage = {
  id: number;
  name: string;
  dataUrl: string;
  source?: 'upload' | 'selection';
};

type ImageQuality = '1K' | '2K' | '4K';

type GenerateImageRequest = {
  type: 'generate-image';
  prompt: string;
  model: string;
  quality: ImageQuality;
  aspectRatio: string;
  references: ReferenceImage[];
};

type HistoryItem = {
  id: string;
  prompt: string;
  model: string;
  quality?: ImageQuality;
  aspectRatio?: string;
  imageDataUrl: string;
  referenceDataUrl?: string;
  createdAt: number;
};

type PluginMessage =
  | {type: 'request-api-key'; pendingRequest: GenerateImageRequest}
  | {type: 'api-key-status' | 'api-key-saved' | 'api-key-cleared'; hasApiKey: boolean}
  | {type: 'history-loaded'; history: HistoryItem[]}
  | {type: 'selection-reference-updated'; reference: ReferenceImage | null}
  | {type: 'generation-started' | 'generation-finished' | 'generation-error'; message?: string};

const modelOptions = imageModels.map((item) => item.name);
const qualityOptions: ImageQuality[] = ['1K', '2K', '4K'];
const MAX_REFERENCE_COUNT = 6;
const MAX_REFERENCE_BYTES = 20 * 1024 * 1024;
const ALLOWED_REFERENCE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

export function App() {
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState('Nano Banana 2');
  const [quality, setQuality] = useState<ImageQuality>('1K');
  const [aspectRatio, setAspectRatio] = useState('auto');
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [isApiKeyOpen, setIsApiKeyOpen] = useState(false);
  const [isDraggingReference, setIsDraggingReference] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [hasApiKey, setHasApiKey] = useState(false);
  const [pendingRequest, setPendingRequest] = useState<GenerateImageRequest | null>(null);
  const [references, setReferences] = useState<ReferenceImage[]>([]);
  const [selectedReference, setSelectedReference] = useState<ReferenceImage | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const dragDepthRef = useRef(0);

  const visibleReferences = useMemo(
    () => (selectedReference ? [selectedReference, ...references] : references),
    [references, selectedReference],
  );
  const currentModel = imageModels.find((item) => item.name === model) ?? imageModels[0];
  const aspectRatioOptions = currentModel.aspectRatios;
  const selectedAspectRatio = aspectRatioOptions.includes(aspectRatio) ? aspectRatio : 'auto';
  const isQualityLimited = currentModel.autoResolutionOnly1K && selectedAspectRatio === 'auto';
  const canGenerate = prompt.trim().length > 3 && !isGenerating;
  const isEditMode = Boolean(selectedReference);

  useEffect(() => {
    const handleMessage = (event: MessageEvent<{pluginMessage?: PluginMessage}>) => {
      const message = event.data.pluginMessage;

      if (!message) {
        return;
      }

      if (message.type === 'request-api-key') {
        setPendingRequest(message.pendingRequest);
        setIsGenerating(false);
        openApiKey();
        return;
      }

      if (message.type === 'api-key-status' || message.type === 'api-key-saved') {
        setHasApiKey(message.hasApiKey);

        if (message.type === 'api-key-saved') {
          setApiKeyInput('');
          setIsApiKeyOpen(false);
        }

        return;
      }

      if (message.type === 'api-key-cleared') {
        setHasApiKey(false);
        setApiKeyInput('');
        return;
      }

      if (message.type === 'generation-started') {
        setIsGenerating(true);
        return;
      }

      if (message.type === 'generation-finished' || message.type === 'generation-error') {
        setIsGenerating(false);
        return;
      }

      if (message.type === 'history-loaded') {
        setHistory(message.history);
        return;
      }

      if (message.type === 'selection-reference-updated') {
        setSelectedReference(message.reference);
      }
    };

    window.addEventListener('message', handleMessage);
    postPluginMessage({type: 'request-history'});
    postPluginMessage({type: 'request-api-key-status'});

    return () => window.removeEventListener('message', handleMessage);
  }, []);

  useEffect(() => {
    postPluginMessage({
      type: 'resize-ui',
      height: visibleReferences.length || isHistoryOpen || isApiKeyOpen || isDraggingReference ? 220 : 200,
    });
  }, [visibleReferences.length, isHistoryOpen, isApiKeyOpen, isDraggingReference]);

  function openApiKey() {
    setIsApiKeyOpen(true);
    setIsHistoryOpen(false);
    setIsModelMenuOpen(false);
  }

  function closeApiKey() {
    setIsApiKeyOpen(false);
    setPendingRequest(null);
  }

  function saveApiKey() {
    const apiKey = apiKeyInput.trim();

    if (!apiKey) {
      return;
    }

    postPluginMessage({
      type: 'save-api-key',
      apiKey,
      pendingRequest: pendingRequest ?? undefined,
    });
    setPendingRequest(null);
  }

  function clearApiKey() {
    setPendingRequest(null);
    postPluginMessage({type: 'clear-api-key'});
  }

  function toggleHistory() {
    setIsHistoryOpen((value) => !value);
    setIsApiKeyOpen(false);
    setIsModelMenuOpen(false);
  }

  function insertHistoryItem(item: HistoryItem) {
    setIsHistoryOpen(false);
    postPluginMessage({
      type: 'insert-history',
      itemId: item.id,
    });
  }

  function useHistoryPrompt(item: HistoryItem, event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    setPrompt(item.prompt);
    setModel(item.model);
    const restoredModel = imageModels.find((entry) => entry.name === item.model) ?? imageModels[0];
    const restoredRatio = item.aspectRatio && restoredModel.aspectRatios.includes(item.aspectRatio) ? item.aspectRatio : 'auto';
    setAspectRatio(restoredRatio);
    setQuality(restoredModel.autoResolutionOnly1K && restoredRatio === 'auto' ? '1K' : item.quality ?? '1K');
    setIsHistoryOpen(false);
  }

  async function onReferenceUpload(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);

    await addReferenceFiles(files);
    event.target.value = '';
  }

  function onDragEnter(event: DragEvent<HTMLElement>) {
    if (!hasImageDrag(event)) {
      return;
    }

    event.preventDefault();
    dragDepthRef.current += 1;
    setIsDraggingReference(true);
  }

  function onDragOver(event: DragEvent<HTMLElement>) {
    if (!hasImageDrag(event)) {
      return;
    }

    event.preventDefault();

    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }
  }

  function onDragLeave(event: DragEvent<HTMLElement>) {
    if (!isDraggingReference) {
      return;
    }

    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);

    if (dragDepthRef.current === 0) {
      setIsDraggingReference(false);
    }
  }

  async function onDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    dragDepthRef.current = 0;
    setIsDraggingReference(false);

    const files = Array.from(event.dataTransfer?.files ?? []).filter((file) => file.type.startsWith('image/'));

    await addReferenceFiles(files);
  }

  function removeReference(reference: ReferenceImage) {
    if (reference.source === 'selection') {
      setSelectedReference(null);
      return;
    }

    setReferences((items) => items.filter((item) => item.id !== reference.id));
  }

  function generate() {
    if (!canGenerate) {
      return;
    }

    setIsGenerating(true);
    postPluginMessage({
      type: 'generate-image',
      prompt: prompt.trim(),
      model,
      quality: isQualityLimited ? '1K' : quality,
      aspectRatio: selectedAspectRatio,
      references: visibleReferences,
    });
  }

  async function addReferenceFiles(files: File[]) {
    const imageFiles = files.filter((file) => ALLOWED_REFERENCE_TYPES.has(file.type));
    const oversizedFile = imageFiles.find((file) => file.size > MAX_REFERENCE_BYTES);

    if (oversizedFile) {
      window.alert(`Файл ${oversizedFile.name} превышает лимит 20 МБ.`);
      return;
    }

    if (!imageFiles.length) {
      if (files.length) {
        window.alert('Поддерживаются только PNG, JPEG и WebP.');
      }
      return;
    }

    const availableSlots = Math.max(0, MAX_REFERENCE_COUNT - references.length - (selectedReference ? 1 : 0));
    const filesToRead = imageFiles.slice(0, availableSlots);

    if (!filesToRead.length) {
      window.alert(`Можно добавить не более ${MAX_REFERENCE_COUNT} изображений.`);
      return;
    }

    const uploaded = await Promise.all(
      filesToRead.map(
        (file, index) =>
          new Promise<ReferenceImage>((resolve) => {
            const reader = new FileReader();

            reader.onload = () => {
              resolve({
                id: Date.now() + index,
                name: file.name,
                dataUrl: String(reader.result),
                source: 'upload',
              });
            };

            reader.readAsDataURL(file);
          }),
      ),
    );

    setReferences((items) => [...items, ...uploaded].slice(-MAX_REFERENCE_COUNT));
  }

  function hasImageDrag(event: DragEvent<HTMLElement>) {
    return Array.from(event.dataTransfer?.items ?? []).some((item) => item.kind === 'file' && item.type.startsWith('image/'));
  }

  const shellClassName = [
    'generator-shell',
    isGenerating ? 'generating' : '',
    visibleReferences.length ? 'has-references' : '',
    isHistoryOpen ? 'history-open' : '',
    isApiKeyOpen ? 'api-open' : '',
    isDraggingReference ? 'dragging-reference' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <main
      className={shellClassName}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {isApiKeyOpen ? (
        <ApiKeyScreen
          apiKeyInput={apiKeyInput}
          hasApiKey={hasApiKey}
          onApiKeyInput={setApiKeyInput}
          onBack={closeApiKey}
          onClear={clearApiKey}
          onSave={saveApiKey}
        />
      ) : isHistoryOpen ? (
        <HistoryScreen history={history} onBack={toggleHistory} onInsert={insertHistoryItem} onUsePrompt={useHistoryPrompt} />
      ) : (
        <section className={`prompt-card ${isGenerating ? 'generating' : ''}`} aria-label="Image generation prompt">
          {isDraggingReference ? (
            <div className="drop-zone" aria-hidden="true">
              <span>Replace me</span>
            </div>
          ) : null}

          <div className={`prompt-field ${visibleReferences.length ? 'has-references' : ''}`}>
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              autoComplete="off"
              placeholder="Professional shot of 3D corn in T-farm style"
            />

            {visibleReferences.length ? (
              <div className="references">
                {visibleReferences.map((reference) => (
                  <button
                    className="reference"
                    key={`${reference.source ?? 'upload'}-${reference.id}-${reference.name}`}
                    type="button"
                    aria-label={`Remove ${reference.name}`}
                    onClick={() => removeReference(reference)}
                  >
                    <img src={reference.dataUrl} alt={reference.name} />
                    <span aria-hidden="true">x</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          <div className="toolbar">
            <div className="model-control">
              <button
                type="button"
                className="model-trigger"
                aria-label="Model"
                title={model}
                aria-expanded={isModelMenuOpen}
                onClick={() => setIsModelMenuOpen((value) => !value)}
              >
                <span>{model}</span>
                <i aria-hidden="true" />
              </button>

              {isModelMenuOpen ? (
                <div className="model-menu" role="listbox">
                  {modelOptions.map((option) => (
                    <button
                      className={`model-option ${option === model ? 'selected' : ''}`}
                      type="button"
                      role="option"
                      key={option}
                      aria-selected={option === model}
                      onClick={() => {
                        const nextModel = imageModels.find((item) => item.name === option)!;
                        const nextRatio = nextModel.aspectRatios.includes(selectedAspectRatio) ? selectedAspectRatio : 'auto';
                        setModel(option);
                        setAspectRatio(nextRatio);
                        if (nextModel.autoResolutionOnly1K && nextRatio === 'auto') setQuality('1K');
                        setIsModelMenuOpen(false);
                      }}
                    >
                      {option}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

            <div className="quality-control" role="group" aria-label="Image quality">
              {qualityOptions.map((option) => (
                <button
                  className={`quality-option ${option === (isQualityLimited ? '1K' : quality) ? 'selected' : ''}`}
                  type="button"
                  key={option}
                  aria-pressed={option === (isQualityLimited ? '1K' : quality)}
                  disabled={isQualityLimited && option !== '1K'}
                  title={isQualityLimited && option !== '1K' ? 'Выберите соотношение сторон для этого разрешения' : option}
                  onClick={() => setQuality(option)}
                >
                  {option}
                </button>
              ))}
            </div>

            <select
              className="aspect-ratio-control"
              aria-label="Соотношение сторон"
              title="Соотношение сторон"
              value={selectedAspectRatio}
              onChange={(event) => {
                const nextRatio = event.target.value;
                setAspectRatio(nextRatio);
                if (currentModel.autoResolutionOnly1K && nextRatio === 'auto') setQuality('1K');
              }}
            >
              {aspectRatioOptions.map((option) => (
                <option key={option} value={option}>{option === 'auto' ? 'Авто' : option}</option>
              ))}
            </select>

            <label className="upload-control" aria-label="Upload reference image">
              <input type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={onReferenceUpload} />
              <img className="control-icon image-icon" src="icons/image.svg" alt="" aria-hidden="true" />
            </label>

            <button className="history-trigger" type="button" aria-label="History" aria-expanded={isHistoryOpen} onClick={toggleHistory}>
              <WindowClockIcon />
            </button>

            <button className={`api-trigger ${hasApiKey ? 'saved' : ''}`} type="button" aria-label="API key" onClick={openApiKey}>
              <ApiIcon />
            </button>

            <button className={`harvest-button ${isGenerating ? 'loading' : ''}`} type="button" disabled={!canGenerate} onClick={generate}>
              {isGenerating ? <img src="icons/spinner.svg" alt="" aria-hidden="true" /> : <span>{isEditMode ? 'Edit image' : 'Harvest!'}</span>}
            </button>
          </div>
        </section>
      )}
    </main>
  );
}

function ApiKeyScreen(props: {
  apiKeyInput: string;
  hasApiKey: boolean;
  onApiKeyInput: (value: string) => void;
  onBack: () => void;
  onClear: () => void;
  onSave: () => void;
}) {
  return (
    <section className="api-screen" aria-label="API key settings">
      <button className="screen-back" type="button" aria-label="Back" onClick={props.onBack}>
        <img src="icons/arrow_back.svg" alt="" aria-hidden="true" />
      </button>
      <h1>API ключ</h1>

      <label className="api-key-field">
        <span>Polza AI</span>
        <input
          type="password"
          value={props.apiKeyInput}
          onChange={(event) => props.onApiKeyInput(event.target.value)}
          autoComplete="off"
          placeholder="pza_..."
        />
      </label>

      <div className="api-actions">
        <button className="api-clear" type="button" disabled={!props.hasApiKey} onClick={props.onClear}>
          Очистить
        </button>
        <button className="api-save" type="button" disabled={!props.apiKeyInput.trim()} onClick={props.onSave}>
          Сохранить
        </button>
      </div>

      <p className="api-status">{props.hasApiKey ? 'Ключ сохранен локально' : 'Ключ не сохранен'}</p>
    </section>
  );
}

function HistoryScreen(props: {
  history: HistoryItem[];
  onBack: () => void;
  onInsert: (item: HistoryItem) => void;
  onUsePrompt: (item: HistoryItem, event: MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <section className="history-screen" aria-label="Generation history">
      <button className="history-back" type="button" aria-label="Back" onClick={props.onBack}>
        <img src="icons/arrow_back.svg" alt="" aria-hidden="true" />
      </button>
      <h1>История</h1>

      {!props.history.length ? <p className="history-empty">Пока ничего не выросло</p> : null}

      {props.history.length ? (
        <div className="history-grid">
          {props.history.map((item) => (
            <button
              className="history-tile"
              type="button"
              key={item.id}
              aria-label={item.prompt}
              title="Click to insert. Alt-click to reuse prompt."
              onClick={(event) => (event.altKey ? props.onUsePrompt(item, event) : props.onInsert(item))}
            >
              <img src={item.imageDataUrl} alt={item.prompt} />
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function WindowClockIcon() {
  return (
    <svg className="control-icon window-clock-icon" aria-hidden="true" viewBox="0 0 18 18">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M4.5 1.5H16.5V4.5H1.5C1.5 2.84315 2.84315 1.5 4.5 1.5Z"
        fill="url(#clock-gradient-a)"
      />
      <path
        d="M16.5 8.55176C15.4727 7.44386 14.0051 6.75 12.375 6.75C9.2684 6.75 6.75 9.2684 6.75 12.375C6.75 14.0051 7.44386 15.4727 8.55176 16.5H1.5V4.5H16.5V8.55176Z"
        fill="url(#clock-gradient-b)"
      />
      <path
        d="M11.8638 9.30688C12.4285 9.30696 12.8861 9.76465 12.8862 10.3293V12.583L14.0215 13.1125C14.5334 13.3513 14.7553 13.96 14.5166 14.4719L14.4082 14.7034L11.6082 13.3975V9.30688H11.8638Z"
        fill="url(#clock-gradient-b)"
      />
      <path
        opacity="0.5"
        fillRule="evenodd"
        clipRule="evenodd"
        d="M12.375 6.75C14.0051 6.75 15.4727 7.44386 16.5 8.55176V13.5C16.5 15.1569 15.1569 16.5 13.5 16.5H8.55176C7.44386 15.4727 6.75 14.0051 6.75 12.375C6.75 9.2684 9.2684 6.75 12.375 6.75ZM11.6082 9.30688V13.3975L14.4082 14.7034L14.5166 14.4719C14.7553 13.96 14.5334 13.3513 14.0215 13.1125L12.8862 12.583V10.3293C12.8861 9.76465 12.4285 9.30696 11.8638 9.30688H11.6082Z"
        fill="url(#clock-gradient-c)"
      />
      <defs>
        <linearGradient id="clock-gradient-a" x1="1.5" y1="4.5" x2="16.5" y2="4.5" gradientUnits="userSpaceOnUse">
          <stop stopColor="#333333" stopOpacity="0.35" />
          <stop offset="1" stopColor="#333333" stopOpacity="0.45" />
        </linearGradient>
        <linearGradient id="clock-gradient-b" x1="4.125" y1="14.175" x2="11.3158" y2="5.30329" gradientUnits="userSpaceOnUse">
          <stop stopColor="#333333" />
          <stop offset="1" stopColor="#333333" stopOpacity="0.7" />
        </linearGradient>
        <linearGradient id="clock-gradient-c" x1="9" y1="9.23077" x2="16.0588" y2="14.9661" gradientUnits="userSpaceOnUse">
          <stop stopColor="#333333" stopOpacity="0.35" />
          <stop offset="1" stopColor="#333333" stopOpacity="0.7" />
        </linearGradient>
      </defs>
    </svg>
  );
}

function ApiIcon() {
  return (
    <svg className="control-icon api-icon" aria-hidden="true" viewBox="0 0 18 18">
      <path
        d="M6.8 10.2a4.2 4.2 0 1 1 3-3L16 13.4V16h-2.6l-.9-.9h-1.7v-1.7l-.9-.9H8.2l-1.4-1.4Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M5.8 5.8h.01" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

function postPluginMessage(pluginMessage: unknown) {
  parent.postMessage({pluginMessage}, '*');
}
