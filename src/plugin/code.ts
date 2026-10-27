/// <reference types="@figma/plugin-typings" />

import imageModels from '../shared/image-models.json';

type ReferenceImage = {
  id?: number;
  name: string;
  dataUrl: string;
  source?: 'upload' | 'selection';
};

type ImageQuality = '1K' | '2K' | '4K';

type GenerateImageMessage = {
  type: 'generate-image';
  prompt: string;
  model: string;
  quality?: ImageQuality;
  aspectRatio?: string;
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

type SaveApiKeyMessage = {
  type: 'save-api-key';
  apiKey: string;
  pendingRequest?: GenerateImageMessage;
};

type InsertHistoryMessage = {
  type: 'insert-history';
  itemId: string;
};

type ActionLogEntry = {
  id: string;
  type: string;
  createdAt: number;
  details?: Record<string, string | number | boolean | null>;
};

type GenerationIndicator = {
  mode: 'new' | 'edit';
  node: RectangleNode;
  complete: (imageBytes: Uint8Array, prompt: string) => Promise<void>;
  dispose: () => void;
};

type ShimmerAnimation = {
  stop: () => void;
  remove: () => void;
};

type ImageDimensions = {
  width: number;
  height: number;
};

type UiMessage =
  | GenerateImageMessage
  | SaveApiKeyMessage
  | InsertHistoryMessage
  | {type: 'clear-api-key'}
  | {type: 'request-api-key-status'}
  | {type: 'request-history'}
  | {type: 'resize-ui'; height: number};

type PolzaImageValue = string | {url?: string; b64_json?: string; images?: PolzaImageValue[]; output?: PolzaImageValue | PolzaImageValue[]};

type PolzaImageResponse = {
  id?: string;
  requestId?: string;
  taskId?: string;
  warnings?: string[];
  status?: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
  error?: string | {message?: string};
  data?: PolzaImageValue | PolzaImageValue[];
  image?: string;
  images?: PolzaImageValue[];
  output?: PolzaImageValue | PolzaImageValue[];
  url?: string;
  b64_json?: string;
};

const LEGACY_API_KEY_STORAGE_KEY = 'polza-ai-api-key';
const API_KEY_STORAGE_KEY = 'polza-ai-user-api-key-v2';
const HISTORY_STORAGE_KEY = 'polza-ai-generation-history';
const ACTION_LOG_STORAGE_KEY = 'polza-ai-action-log-v1';
const HISTORY_LIMIT = 24;
const ACTION_LOG_LIMIT = 5000;
const PLUGIN_BUILD = '2026-10-27.4';
const PLUGIN_UI_WIDTH = 600;
const POLZA_MEDIA_ENDPOINT = 'https://polza.ai/api/v1/media';
const POLZA_POLL_INTERVAL_MS = 3500;
const POLZA_POLL_TIMEOUT_MS = 10 * 60 * 1000;
const ALLOWED_IMAGE_HOSTS = new Set(['polza.ai', 's3.polza.ai']);
const MAX_REFERENCE_COUNT = 6;
const MAX_REFERENCE_BYTES = 20 * 1024 * 1024;
const MAX_REFERENCES_TOTAL_BYTES = 60 * 1024 * 1024;
const MAX_GENERATED_IMAGE_BYTES = 40 * 1024 * 1024;
let lastSelectionImageKey = '';

figma.showUI(__html__, {
  width: PLUGIN_UI_WIDTH,
  height: 200,
  themeColors: true,
});

void postHistory();

if (figma.command !== 'export-action-log') {
  void postSelectionReference();
  figma.on('selectionchange', () => {
    void postSelectionReference();
  });
}

figma.ui.onmessage = async (message: UiMessage) => {
  try {
    if (message.type === 'request-api-key-status') {
      await postApiKeyStatus();
      return;
    }

    if (message.type === 'request-history') {
      await postHistory();
      return;
    }

    if (message.type === 'resize-ui') {
      figma.ui.resize(PLUGIN_UI_WIDTH, message.height);
      return;
    }

    if (message.type === 'clear-api-key') {
      await figma.clientStorage.deleteAsync(API_KEY_STORAGE_KEY);
      await figma.clientStorage.deleteAsync(LEGACY_API_KEY_STORAGE_KEY);
      await logAction('api_key_cleared');
      figma.notify('Polza AI API key removed');
      figma.ui.postMessage({type: 'api-key-cleared', hasApiKey: false});
      return;
    }

    if (message.type === 'insert-history') {
      const history = await getHistory();
      const item = history.find((entry) => entry.id === message.itemId);

      if (!item) {
        await logAction('history_insert_missing', {itemId: message.itemId});
        figma.notify('History item not found', {error: true});
        return;
      }

      await logAction('history_insert_started', {
        promptLength: item.prompt.length,
        model: item.model,
      });
      await insertImageDataUrl(item.imageDataUrl, item.prompt);
      await logAction('history_insert_finished', {
        promptLength: item.prompt.length,
        model: item.model,
      });
      return;
    }

    if (message.type === 'save-api-key') {
      const apiKey = message.apiKey.trim();

      if (!apiKey) {
        figma.ui.postMessage({type: 'generation-error', message: 'API key is empty'});
        return;
      }

      await figma.clientStorage.setAsync(API_KEY_STORAGE_KEY, apiKey);
      await logAction('api_key_saved', {
        keyLength: apiKey.length,
        hasPendingRequest: Boolean(message.pendingRequest),
      });
      figma.ui.postMessage({type: 'api-key-saved', hasApiKey: true});

      if (message.pendingRequest) {
        await generateAndInsertImage(message.pendingRequest, apiKey);
      }

      return;
    }

    if (message.type === 'generate-image') {
      const apiKey = await figma.clientStorage.getAsync(API_KEY_STORAGE_KEY);

      if (!apiKey) {
        await logAction('generation_blocked_missing_api_key', {
          model: message.model,
          quality: getImageQuality(message),
          promptLength: message.prompt.length,
          referencesCount: message.references.length,
        });
        figma.ui.postMessage({
          type: 'request-api-key',
          pendingRequest: message,
        });
        return;
      }

      await generateAndInsertImage(message, apiKey);
    }
  } catch (error) {
    const errorMessage = errorToMessage(error);
    await logAction('error', {message: errorMessage});

    figma.notify(errorMessage, {error: true});
    figma.ui.postMessage({
      type: 'generation-error',
      message: errorMessage,
    });
  }
};

if (figma.command === 'export-action-log') {
  void exportActionLog();
}

async function generateAndInsertImage(message: GenerateImageMessage, apiKey: string): Promise<void> {
  validateGenerationRequest(message);
  const startedAt = Date.now();
  const indicator = createGenerationIndicator(message.references.some((reference) => reference.source === 'selection'), message.prompt);
  let indicatorCompleted = false;

  figma.ui.postMessage({type: 'generation-started'});
  figma.notify(`Generating with Polza AI: ${message.prompt.slice(0, 72)}`);
  await logAction('generation_started', {
    build: PLUGIN_BUILD,
    model: message.model,
    normalizedModel: normalizeModel(message.model),
    aspectRatio: getAspectRatio(message),
    quality: getImageQuality(message),
    promptLength: message.prompt.length,
    referencesCount: message.references.length,
    referencesBytesApprox: getReferencesBytesApprox(message.references),
  });

  try {
    const generated = await generateImageWithPolza({
      apiKey,
      prompt: message.prompt,
      model: normalizeModel(message.model),
      quality: getImageQuality(message),
      aspectRatio: getAspectRatio(message),
      references: message.references,
    });

    const dimensions = getImageDimensions(generated.bytes);
    await logAction('provider_image_received', {
      quality: getImageQuality(message),
      aspectRatio: getAspectRatio(message),
      width: dimensions?.width ?? 0,
      height: dimensions?.height ?? 0,
      imageBytes: generated.bytes.length,
    });
    await indicator.complete(generated.bytes, message.prompt);
    indicatorCompleted = true;
    await logAction('image_inserted', {
      model: message.model,
      quality: getImageQuality(message),
      promptLength: message.prompt.length,
      imageBytes: generated.bytes.length,
      durationMs: Date.now() - startedAt,
    });

    const isHistorySaved = await saveHistoryItem({
      id: `${Date.now()}`,
      prompt: message.prompt,
      model: message.model,
      quality: getImageQuality(message),
      aspectRatio: getAspectRatio(message),
      imageDataUrl: generated.dataUrl,
      createdAt: Date.now(),
    });

    figma.notify('Image inserted');

    if (!isHistorySaved) {
      await logAction('history_save_failed_storage_full', {
        model: message.model,
        quality: getImageQuality(message),
        promptLength: message.prompt.length,
        imageBytes: generated.bytes.length,
      });
      figma.notify('Image inserted, but history storage is full', {timeout: 3500});
    } else {
      await logAction('history_save_finished', {
        model: message.model,
        quality: getImageQuality(message),
        promptLength: message.prompt.length,
        durationMs: Date.now() - startedAt,
      });
    }

    await logAction('generation_finished', {
      model: message.model,
      quality: getImageQuality(message),
      promptLength: message.prompt.length,
      referencesCount: message.references.length,
      imageBytes: generated.bytes.length,
      durationMs: Date.now() - startedAt,
      historySaved: isHistorySaved,
    });
    figma.ui.postMessage({type: 'generation-finished'});
  } finally {
    if (!indicatorCompleted) {
      indicator.dispose();
    }
  }
}

async function insertImageDataUrl(dataUrl: string, prompt: string): Promise<void> {
  await insertImageBytes(dataUrlOrBase64ToBytes(dataUrl), prompt);
  figma.notify('History image inserted');
}

async function insertImageBytes(imageBytes: Uint8Array, prompt: string): Promise<void> {
  const image = figma.createImage(imageBytes);
  const node = figma.createRectangle();
  const bounds = figma.viewport.bounds;
  const dimensions = getImageDimensions(imageBytes);
  const width = dimensions?.width ?? 512;
  const height = dimensions?.height ?? 512;

  node.name = `Polza AI - ${prompt.slice(0, 40)}`;
  node.resize(width, height);
  node.x = bounds.x + bounds.width / 2 - width / 2;
  node.y = bounds.y + bounds.height / 2 - height / 2;
  node.fills = [
    {
      type: 'IMAGE',
      scaleMode: 'FILL',
      imageHash: image.hash,
    },
  ];

  figma.currentPage.appendChild(node);
  figma.currentPage.selection = [node];
  figma.viewport.scrollAndZoomIntoView([node]);
}

async function paintNodeWithImage(node: RectangleNode, imageBytes: Uint8Array, prompt: string): Promise<void> {
  const image = figma.createImage(imageBytes);
  const dimensions = getImageDimensions(imageBytes);
  const centerX = node.x + node.width / 2;
  const centerY = node.y + node.height / 2;

  node.name = `Polza AI - ${prompt.slice(0, 40)}`;
  node.opacity = 1;
  node.cornerRadius = 0;
  if (dimensions) {
    node.resize(dimensions.width, dimensions.height);
    node.x = centerX - dimensions.width / 2;
    node.y = centerY - dimensions.height / 2;
  }
  node.fills = [
    {
      type: 'IMAGE',
      scaleMode: 'FILL',
      imageHash: image.hash,
    },
  ];

  figma.currentPage.selection = [node];
  figma.viewport.scrollAndZoomIntoView([node]);
}

function createGenerationIndicator(isEditingSelectedImage: boolean, prompt: string): GenerationIndicator {
  const selectedImage = isEditingSelectedImage ? findSelectedImagePaint()?.node ?? null : null;

  return selectedImage ? createEditGenerationOverlay(selectedImage, prompt) : createNewGenerationSkeleton(prompt);
}

function createNewGenerationSkeleton(prompt: string): GenerationIndicator {
  const node = figma.createRectangle();
  const bounds = figma.viewport.bounds;
  const size = 512;

  node.name = `Polza AI - Generating - ${prompt.slice(0, 32)}`;
  node.resize(size, size);
  node.x = bounds.x + bounds.width / 2 - size / 2;
  node.y = bounds.y + bounds.height / 2 - size / 2;
  node.cornerRadius = 0;
  node.fills = [getLoadingBackgroundFill()];

  figma.currentPage.appendChild(node);
  figma.currentPage.selection = [node];
  figma.viewport.scrollAndZoomIntoView([node]);

  const shimmer = createShimmer(node);

  return {
    mode: 'new',
    node,
    complete: async (imageBytes, finalPrompt) => {
      shimmer.stop();
      shimmer.remove();
      await paintNodeWithImage(node, imageBytes, finalPrompt);
    },
    dispose: () => {
      shimmer.stop();
      shimmer.remove();
      removeNode(node);
    },
  };
}

function createEditGenerationOverlay(target: SceneNode, prompt: string): GenerationIndicator {
  const node = figma.createRectangle();

  node.name = `Polza AI - Editing - ${prompt.slice(0, 32)}`;
  node.resize(getNodeWidth(target), getNodeHeight(target));
  node.x = 'x' in target ? target.x : 0;
  node.y = 'y' in target ? target.y : 0;
  node.opacity = 1;
  node.cornerRadius = 0;
  node.fills = [getLoadingBackgroundFill()];

  const parent = target.parent;

  if (parent && 'appendChild' in parent) {
    parent.appendChild(node);
  } else {
    figma.currentPage.appendChild(node);
  }

  const shimmer = createShimmer(node);

  return {
    mode: 'edit',
    node,
    complete: async (imageBytes, finalPrompt) => {
      shimmer.stop();
      shimmer.remove();
      removeNode(node);
      await insertImageBytes(imageBytes, finalPrompt);
    },
    dispose: () => {
      shimmer.stop();
      shimmer.remove();
      removeNode(node);
    },
  };
}

function createShimmer(node: RectangleNode): ShimmerAnimation {
  const shimmer = figma.createRectangle();
  const shimmerWidth = Math.max(40, node.width * 0.28);
  const shimmerHeight = Math.max(40, node.height * 0.28);

  shimmer.name = 'Polza AI - Loading shimmer';
  shimmer.resize(shimmerWidth, shimmerHeight);
  shimmer.x = node.x;
  shimmer.y = node.y;
  shimmer.cornerRadius = 0;
  shimmer.opacity = 0.2;
  shimmer.fills = [getShimmerHighlightFill()];

  const parent = node.parent;

  if (parent && 'appendChild' in parent) {
    parent.appendChild(shimmer);
  } else {
    figma.currentPage.appendChild(shimmer);
  }

  const startedAt = Date.now();
  const durationMs = 1500;
  const timer = setInterval(() => {
    if (node.removed || shimmer.removed) {
      clearInterval(timer);
      return;
    }

    const progress = ((Date.now() - startedAt) % durationMs) / durationMs;

    shimmer.x = node.x + progress * Math.max(0, node.width - shimmerWidth);
    shimmer.y = node.y + progress * Math.max(0, node.height - shimmerHeight);
  }, 50);

  return {
    stop: () => clearInterval(timer),
    remove: () => removeNode(shimmer),
  };
}

function getLoadingBackgroundFill(): SolidPaint {
  return {
    type: 'SOLID',
    color: {r: 0.06, g: 0.06, b: 0.06},
    opacity: 0.5,
  };
}

function getShimmerHighlightFill(): GradientPaint {
  return {
    type: 'GRADIENT_RADIAL',
    gradientTransform: [
      [1, 0, 0],
      [0, 1, 0],
    ],
    gradientStops: [
      {position: 0, color: {r: 1, g: 1, b: 1, a: 1}},
      {position: 0.5, color: {r: 1, g: 1, b: 1, a: 0.45}},
      {position: 1, color: {r: 1, g: 1, b: 1, a: 0}},
    ],
  };
}

function getNodeWidth(node: SceneNode): number {
  return 'width' in node ? Math.max(1, node.width) : 512;
}

function getNodeHeight(node: SceneNode): number {
  return 'height' in node ? Math.max(1, node.height) : 512;
}

function getImageDimensions(imageBytes: Uint8Array): ImageDimensions | null {
  return getPngDimensions(imageBytes) ?? getJpegDimensions(imageBytes) ?? getWebpDimensions(imageBytes);
}

function getPngDimensions(imageBytes: Uint8Array): ImageDimensions | null {
  const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

  if (imageBytes.length < 24 || !pngSignature.every((byte, index) => imageBytes[index] === byte)) {
    return null;
  }

  return {
    width: readUint32BigEndian(imageBytes, 16),
    height: readUint32BigEndian(imageBytes, 20),
  };
}

function getJpegDimensions(imageBytes: Uint8Array): ImageDimensions | null {
  if (imageBytes.length < 4 || imageBytes[0] !== 0xff || imageBytes[1] !== 0xd8) {
    return null;
  }

  let offset = 2;

  while (offset + 9 < imageBytes.length) {
    if (imageBytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    const marker = imageBytes[offset + 1];

    if (marker === 0xda || marker === 0xd9) {
      return null;
    }

    const segmentLength = readUint16BigEndian(imageBytes, offset + 2);

    if (segmentLength < 2 || offset + 2 + segmentLength > imageBytes.length) {
      return null;
    }

    if (isJpegStartOfFrameMarker(marker)) {
      return {
        height: readUint16BigEndian(imageBytes, offset + 5),
        width: readUint16BigEndian(imageBytes, offset + 7),
      };
    }

    offset += 2 + segmentLength;
  }

  return null;
}

function getWebpDimensions(imageBytes: Uint8Array): ImageDimensions | null {
  if (
    imageBytes.length < 30 ||
    readAscii(imageBytes, 0, 4) !== 'RIFF' ||
    readAscii(imageBytes, 8, 4) !== 'WEBP'
  ) {
    return null;
  }

  const chunkType = readAscii(imageBytes, 12, 4);

  if (chunkType === 'VP8X') {
    return {
      width: 1 + readUint24LittleEndian(imageBytes, 24),
      height: 1 + readUint24LittleEndian(imageBytes, 27),
    };
  }

  if (chunkType === 'VP8 ' && imageBytes.length >= 30) {
    return {
      width: readUint16LittleEndian(imageBytes, 26) & 0x3fff,
      height: readUint16LittleEndian(imageBytes, 28) & 0x3fff,
    };
  }

  if (chunkType === 'VP8L' && imageBytes.length >= 25) {
    const bits =
      imageBytes[21] | (imageBytes[22] << 8) | (imageBytes[23] << 16) | (imageBytes[24] << 24);

    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }

  return null;
}

function isJpegStartOfFrameMarker(marker: number): boolean {
  return (
    (marker >= 0xc0 && marker <= 0xc3) ||
    (marker >= 0xc5 && marker <= 0xc7) ||
    (marker >= 0xc9 && marker <= 0xcb) ||
    (marker >= 0xcd && marker <= 0xcf)
  );
}

function readUint32BigEndian(bytes: Uint8Array, offset: number): number {
  return bytes[offset] * 0x1000000 + ((bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]);
}

function readUint24LittleEndian(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function readUint16BigEndian(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function readUint16LittleEndian(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.slice(offset, offset + length));
}

function removeNode(node: SceneNode): void {
  if (!node.removed) {
    node.remove();
  }
}

async function generateImageWithPolza(options: {
  apiKey: string;
  prompt: string;
  model: string;
  quality: ImageQuality;
  aspectRatio?: string;
  references: ReferenceImage[];
}): Promise<{bytes: Uint8Array; dataUrl: string}> {
  const response = await fetch(POLZA_MEDIA_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: options.model,
      input: {
        prompt: options.prompt,
        aspect_ratio: getAspectRatio(options),
        image_resolution: options.quality,
        max_images: 1,
        output_format: 'png',
        images: options.references.map((reference) => ({
          type: 'base64',
          data: reference.dataUrl,
        })),
      },
      async: true,
    }),
  });

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(`Polza AI API error ${response.status}: ${responseText.slice(0, 240)}`);
  }

  const payload = JSON.parse(responseText) as PolzaImageResponse;
  await logAction('provider_request_accepted', {
    requestId: payload.requestId || payload.id || payload.taskId || '',
    status: payload.status || 'unknown',
    model: options.model,
    quality: options.quality,
    aspectRatio: getAspectRatio(options),
  });
  await logPolzaWarnings(payload);
  const completedPayload = await resolvePolzaPayload(payload, options.apiKey);
  const imageSource = extractImageSource(completedPayload);

  if (!imageSource) {
    throw new Error('Polza AI response does not contain an image');
  }

  if (imageSource.startsWith('http')) {
    const bytes = await fetchImageBytes(imageSource);

    return {
      bytes,
      dataUrl: bytesToDataUrl(bytes, 'image/png'),
    };
  }

  const bytes = dataUrlOrBase64ToBytes(imageSource, MAX_GENERATED_IMAGE_BYTES);
  assertSupportedImageBytes(bytes);

  return {
    bytes,
    dataUrl: imageSource.startsWith('data:') ? imageSource : `data:image/png;base64,${imageSource}`,
  };
}

async function getHistory(): Promise<HistoryItem[]> {
  return ((await figma.clientStorage.getAsync(HISTORY_STORAGE_KEY)) || []) as HistoryItem[];
}

async function saveHistoryItem(item: HistoryItem): Promise<boolean> {
  const history = await getHistory();
  const candidates = [item, ...history].slice(0, HISTORY_LIMIT);

  for (let size = candidates.length; size > 0; size -= 1) {
    const nextHistory = candidates.slice(0, size);

    try {
      await figma.clientStorage.setAsync(HISTORY_STORAGE_KEY, nextHistory);
      figma.ui.postMessage({
        type: 'history-loaded',
        history: nextHistory,
      });

      return true;
    } catch {
      // Retry with fewer base64 images when Figma clientStorage is full.
    }
  }

  return false;
}

async function postHistory(): Promise<void> {
  figma.ui.postMessage({
    type: 'history-loaded',
    history: await getHistory(),
  });
}

async function postApiKeyStatus(): Promise<void> {
  await figma.clientStorage.deleteAsync(LEGACY_API_KEY_STORAGE_KEY);
  const apiKey = await figma.clientStorage.getAsync(API_KEY_STORAGE_KEY);

  figma.ui.postMessage({
    type: 'api-key-status',
    hasApiKey: typeof apiKey === 'string' && apiKey.trim().length > 0,
  });
}

async function postSelectionReference(): Promise<void> {
  try {
    const selectedImage = findSelectedImagePaint();

    if (!selectedImage) {
      if (lastSelectionImageKey) {
        lastSelectionImageKey = '';
        figma.ui.postMessage({type: 'selection-reference-updated', reference: null});
      }

      return;
    }

    const selectionImageKey = `${selectedImage.paint.imageHash}:${selectedImage.node.id}`;

    if (selectionImageKey === lastSelectionImageKey) {
      return;
    }

    lastSelectionImageKey = selectionImageKey;

    const imageHash = selectedImage.paint.imageHash;
    const image = imageHash ? figma.getImageByHash(imageHash) : null;

    if (!image) {
      figma.ui.postMessage({type: 'selection-reference-updated', reference: null});
      return;
    }

    const bytes = await image.getBytesAsync();
    const reference: ReferenceImage = {
      id: -1,
      name: selectedImage.node.name || 'Selected image',
      dataUrl: bytesToDataUrl(bytes, getImageMimeType(bytes)),
      source: 'selection',
    };

    await logAction('selection_reference_attached', {
      nodeType: selectedImage.node.type,
      nodeNameLength: selectedImage.node.name.length,
      imageBytes: bytes.length,
    });
    figma.ui.postMessage({type: 'selection-reference-updated', reference});
  } catch (error) {
    lastSelectionImageKey = '';
    await logAction('selection_reference_error', {message: errorToMessage(error)});
    figma.ui.postMessage({type: 'selection-reference-updated', reference: null});
  }
}

function findSelectedImagePaint(): {node: SceneNode; paint: ImagePaint} | null {
  for (const node of figma.currentPage.selection) {
    const result = findImagePaintInNode(node);

    if (result) {
      return result;
    }
  }

  return null;
}

function findImagePaintInNode(node: SceneNode): {node: SceneNode; paint: ImagePaint} | null {
  if ('fills' in node && Array.isArray(node.fills)) {
    const imagePaint = node.fills.find((paint): paint is ImagePaint => paint.type === 'IMAGE' && Boolean(paint.imageHash));

    if (imagePaint) {
      return {node, paint: imagePaint};
    }
  }

  if ('children' in node) {
    for (const child of node.children) {
      const result = findImagePaintInNode(child);

      if (result) {
        return result;
      }
    }
  }

  return null;
}

async function logAction(type: string, details?: ActionLogEntry['details']): Promise<void> {
  try {
    const entry: ActionLogEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type,
      createdAt: Date.now(),
      details,
    };
    const current = ((await figma.clientStorage.getAsync(ACTION_LOG_STORAGE_KEY)) || []) as ActionLogEntry[];
    const candidates = [entry, ...current].slice(0, ACTION_LOG_LIMIT);

    for (let size = candidates.length; size > 0; size = Math.floor(size * 0.8)) {
      try {
        await figma.clientStorage.setAsync(ACTION_LOG_STORAGE_KEY, candidates.slice(0, size));
        return;
      } catch {
        // Retry with fewer events when Figma clientStorage is full.
      }
    }
  } catch {
    // Logging must never break plugin workflows.
  }
}

async function exportActionLog(): Promise<void> {
  const entries = ((await figma.clientStorage.getAsync(ACTION_LOG_STORAGE_KEY)) || []) as ActionLogEntry[];
  const payload = JSON.stringify(
    {
      exportedAt: Date.now(),
      plugin: 'Figma API Image Generator',
      version: 1,
      entries,
    },
    null,
    2,
  );
  const safePayload = JSON.stringify(payload).replaceAll('</script', '<\\/script');

  figma.showUI(
    `<style>
      * { box-sizing: border-box; }
      body {
        margin: 0;
        padding: 24px;
        background: #ffffff;
        color: #252525;
        font: 13px/1.4 Inter, system-ui, sans-serif;
      }
      h1 { margin: 0 0 8px; font-size: 18px; line-height: 1.2; }
      p { margin: 0 0 18px; color: #666666; }
      .meta {
        display: flex;
        gap: 16px;
        margin-bottom: 20px;
        padding: 12px;
        border-radius: 10px;
        background: #f5f5f5;
      }
      .meta strong { display: block; color: #252525; font-size: 15px; }
      .meta span { color: #777777; font-size: 11px; }
      .actions { display: grid; gap: 8px; }
      button {
        width: 100%;
        height: 38px;
        border: 0;
        border-radius: 9px;
        font: inherit;
        font-weight: 600;
        cursor: pointer;
      }
      #download { background: #ffdd2d; color: #252525; }
      #close { height: 30px; background: transparent; color: #777777; font-weight: 400; }
      button:disabled { opacity: 0.5; cursor: default; }
      #status { min-height: 18px; margin: 12px 0 0; color: #666666; font-size: 12px; }
      #status.error { color: #d14324; }
    </style>
    <main>
      <h1>Экспорт журнала</h1>
      <p>Сохраните технический журнал для анализа ошибок и времени генерации.</p>
      <div class="meta">
        <div><strong>${entries.length}</strong><span>событий</span></div>
        <div><strong id="size">—</strong><span>размер JSON</span></div>
      </div>
      <div class="actions">
        <button id="download" type="button">Скачать в Downloads</button>
        <button id="close" type="button">Отмена</button>
      </div>
      <p id="status" role="status"></p>
    </main>
    <script>
      const payload = ${safePayload};
      const blob = new Blob([payload], {type: 'application/json'});
      const fileName = 'polza-ai-action-log-' + new Date().toISOString().slice(0, 10) + '.json';
      const downloadButton = document.getElementById('download');
      const closeButton = document.getElementById('close');
      const status = document.getElementById('status');

      document.getElementById('size').textContent = formatBytes(blob.size);

      downloadButton.addEventListener('click', () => {
        setBusy(true);
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        setStatus('Загрузка запущена. Проверьте папку Downloads.');
        finish('download');
      });

      closeButton.addEventListener('click', () => {
        parent.postMessage({pluginMessage: {type: 'export-action-log-cancelled'}}, '*');
      });

      function finish(method) {
        setTimeout(() => {
          parent.postMessage({pluginMessage: {type: 'export-action-log-finished', method, fileName}}, '*');
        }, 300);
      }

      function setBusy(value) {
        downloadButton.disabled = value;
      }

      function setStatus(message, isError = false) {
        status.textContent = message;
        status.className = isError ? 'error' : '';
      }

      function formatBytes(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / 1024 / 1024).toFixed(2) + ' MB';
      }
    </script>`,
    {width: 380, height: 285},
  );
  figma.ui.onmessage = (message: {type?: string; method?: string; fileName?: string}) => {
    if (message.type === 'export-action-log-finished') {
      figma.notify(`Usage log exported: ${entries.length} events`);
      figma.closePlugin();
      return;
    }

    if (message.type === 'export-action-log-cancelled') {
      figma.closePlugin();
    }
  };
}

async function logPolzaWarnings(payload: PolzaImageResponse): Promise<void> {
  if (payload.warnings?.length) {
    const warnings = payload.warnings.join('; ').slice(0, 600);
    await logAction('provider_warning', {warnings});
    figma.notify(`Polza AI: ${warnings}`, {timeout: 6000});
  }
}

function assertPolzaResult(payload: PolzaImageResponse, requestId: string): void {
  if (payload.status === 'failed' || payload.status === 'cancelled' || payload.error) {
    throw new Error(`${getPolzaErrorMessage(payload)} (requestId: ${requestId || 'unknown'})`);
  }
  if (payload.status === 'completed' && !extractImageSource(payload)) {
    throw new Error(`Polza AI completed without an image (requestId: ${requestId || 'unknown'})`);
  }
}

async function resolvePolzaPayload(payload: PolzaImageResponse, apiKey: string): Promise<PolzaImageResponse> {
  const requestId = payload.requestId || payload.id || payload.taskId || '';
  assertPolzaResult(payload, requestId);
  if (extractImageSource(payload)) return payload;
  if (!requestId) throw new Error('Polza AI response contains neither an image nor a task ID');

  const startedAt = Date.now();
  let lastStatus: string = payload.status || 'unknown';
  while (Date.now() - startedAt < POLZA_POLL_TIMEOUT_MS) {
    await delay(POLZA_POLL_INTERVAL_MS);
    const statusPayload = await fetchPolzaMediaStatus(requestId, apiKey);
    if (statusPayload.status !== lastStatus) {
      lastStatus = statusPayload.status || 'unknown';
      await logAction('provider_status', {requestId, status: lastStatus, elapsedMs: Date.now() - startedAt});
    }
    await logPolzaWarnings(statusPayload);
    assertPolzaResult(statusPayload, requestId);
    if (extractImageSource(statusPayload)) return statusPayload;
  }

  await logAction('provider_poll_timeout', {requestId, status: lastStatus, elapsedMs: Date.now() - startedAt});
  throw new Error(`Polza AI: ожидание остановлено через 10 минут. Задача может продолжать выполняться. Проверьте её в кабинете перед повтором (requestId: ${requestId}, status: ${lastStatus})`);
}

async function fetchPolzaMediaStatus(requestId: string, apiKey: string): Promise<PolzaImageResponse> {
  const response = await fetch(`${POLZA_MEDIA_ENDPOINT}/${encodeURIComponent(requestId)}`, {
    headers: {Authorization: `Bearer ${apiKey}`},
  });
  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`Polza AI status check failed ${response.status} (requestId: ${requestId}): ${responseText.slice(0, 160)}`);
  }
  return JSON.parse(responseText) as PolzaImageResponse;
}

function extractImageSource(payload: PolzaImageResponse): string | null {
  function readImage(value: PolzaImageValue | PolzaImageValue[] | undefined, depth = 0): string | null {
    if (!value || depth > 4) return null;
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
      for (const item of value) {
        const source = readImage(item, depth + 1);
        if (source) return source;
      }
      return null;
    }
    return value.b64_json || value.url || readImage(value.images, depth + 1) || readImage(value.output, depth + 1);
  }
  return readImage(payload.data) || readImage(payload.images) || readImage(payload.output) || payload.b64_json || payload.image || payload.url || null;
}

function getSupportedAspectRatios(model: string): string[] {
  return imageModels.find((item) => item.name === model || item.id === model)?.aspectRatios ?? ['auto'];
}

function getAspectRatio(options: {model: string; aspectRatio?: string}): string {
  const ratio = options.aspectRatio ?? 'auto';
  if (!getSupportedAspectRatios(options.model).includes(ratio)) {
    throw new Error(`Соотношение ${ratio} не поддерживается выбранной моделью. Выберите формат из списка.`);
  }
  return ratio;
}

function getPolzaErrorMessage(payload: PolzaImageResponse): string {
  if (typeof payload.error === 'string') {
    return payload.error;
  }

  if (typeof payload.error === 'object' && payload.error.message) {
    return payload.error.message;
  }

  return payload.status === 'cancelled' ? 'Polza AI generation cancelled' : 'Polza AI generation failed';
}

async function fetchImageBytes(url: string): Promise<Uint8Array> {
  if (!isAllowedImageUrl(url)) {
    throw new Error('Image download host is not allowed');
  }

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Image download failed ${response.status}`);
  }

  if (response.url && !isAllowedImageUrl(response.url)) {
    throw new Error('Image download redirected to an untrusted host');
  }

  const bytes = new Uint8Array(await response.arrayBuffer());

  if (bytes.length > MAX_GENERATED_IMAGE_BYTES) {
    throw new Error('Generated image is too large');
  }

  assertSupportedImageBytes(bytes);
  return bytes;
}

function isAllowedImageUrl(value: string): boolean {
  const normalizedUrl = value.trim().toLowerCase();

  for (const hostname of ALLOWED_IMAGE_HOSTS) {
    const origin = `https://${hostname}`;

    if (
      normalizedUrl === origin ||
      normalizedUrl.startsWith(`${origin}/`) ||
      normalizedUrl.startsWith(`${origin}?`) ||
      normalizedUrl.startsWith(`${origin}#`)
    ) {
      return true;
    }
  }

  return false;
}

function dataUrlOrBase64ToBytes(value: string, maxBytes = MAX_GENERATED_IMAGE_BYTES): Uint8Array {
  const base64 = value.includes(',') ? value.split(',').pop() || '' : value;

  if (Math.ceil((base64.length * 3) / 4) > maxBytes) {
    throw new Error('Image data is too large');
  }

  const binary = atob(base64);

  if (binary.length > maxBytes) {
    throw new Error('Image data is too large');
  }

  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function bytesToDataUrl(bytes: Uint8Array, mimeType: string): string {
  let binary = '';

  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }

  return `data:${mimeType};base64,${btoa(binary)}`;
}

function getImageMimeType(bytes: Uint8Array): string {
  return detectImageMimeType(bytes) ?? 'image/png';
}

function detectImageMimeType(bytes: Uint8Array): string | null {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }

  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    return 'image/jpeg';
  }

  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return 'image/gif';
  }

  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }

  return null;
}

function assertSupportedImageBytes(bytes: Uint8Array): void {
  if (!bytes.length || !detectImageMimeType(bytes)) {
    throw new Error('Downloaded data is not a supported image');
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getReferencesBytesApprox(references: ReferenceImage[]): number {
  return references.reduce((sum, reference) => {
    const base64 = reference.dataUrl.includes(',') ? reference.dataUrl.split(',').pop() || '' : reference.dataUrl;

    return sum + Math.round((base64.length * 3) / 4);
  }, 0);
}

function validateGenerationRequest(message: GenerateImageMessage): void {
  // Validate settings before creating a loading node or a paid generation.
  const ratio = getAspectRatio(message);
  const model = imageModels.find((item) => item.id === normalizeModel(message.model));
  if (model?.autoResolutionOnly1K && ratio === 'auto' && getImageQuality(message) !== '1K') {
    throw new Error('Для GPT Image 2 формат «Авто» доступен только в 1K. Выберите соотношение сторон для 2K или 4K.');
  }
  if (message.references.length > MAX_REFERENCE_COUNT) {
    throw new Error(`A maximum of ${MAX_REFERENCE_COUNT} reference images is allowed`);
  }

  let totalBytes = 0;

  for (const reference of message.references) {
    if (!reference.dataUrl.startsWith('data:image/')) {
      throw new Error('Reference data must be an image');
    }

    const bytes = getDataUrlBytesApprox(reference.dataUrl);

    if (bytes > MAX_REFERENCE_BYTES) {
      throw new Error(`Reference image "${reference.name.slice(0, 40)}" is too large`);
    }

    totalBytes += bytes;
  }

  if (totalBytes > MAX_REFERENCES_TOTAL_BYTES) {
    throw new Error('Reference images are too large in total');
  }
}

function getDataUrlBytesApprox(dataUrl: string): number {
  const base64 = dataUrl.includes(',') ? dataUrl.split(',').pop() || '' : dataUrl;

  return Math.ceil((base64.length * 3) / 4);
}

function errorToMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return 'Unknown generation error';
  }
}

function normalizeModel(model: string): string {
  return imageModels.find((item) => item.name === model)?.id ?? model;
}

function getImageQuality(message: GenerateImageMessage): ImageQuality {
  if (message.quality === '2K' || message.quality === '4K') {
    return message.quality;
  }

  return '1K';
}
