import {existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync} from 'node:fs';
import {dirname, extname, join, posix} from 'node:path';

const uiBuildDir = join(process.cwd(), 'dist', 'ui-build');
const indexPath = join(uiBuildDir, 'index.html');
const outputPath = join(process.cwd(), 'dist', 'ui.html');

if (!existsSync(indexPath)) {
  throw new Error(`Vite output not found: ${indexPath}`);
}

let html = readFileSync(indexPath, 'utf8');

html = html.replace(/<link rel="stylesheet"[^>]+href="([^"]+)"[^>]*>/g, (_match, href) => {
  const cssPath = resolveUiAsset(href);
  const css = inlineAssetUrls(readFileSync(cssPath, 'utf8'));

  return `<style>${css}</style>`;
});

html = html.replace(/<script type="module" crossorigin src="([^"]+)"><\/script>/g, (_match, src) => {
  const jsPath = resolveUiAsset(src);
  const js = inlineRuntimeAssetReferences(readFileSync(jsPath, 'utf8'))
    .replaceAll('</script', '<\\/script')
    .replaceAll('<!--', '<\\!--');

  return `<script type="module">${js}</script>`;
});

mkdirSync(dirname(outputPath), {recursive: true});
writeFileSync(outputPath, html);

function resolveUiAsset(url) {
  const normalized = url.replace(/^\//, '');
  const fullPath = join(uiBuildDir, normalized);

  if (!existsSync(fullPath)) {
    throw new Error(`UI asset not found: ${fullPath}`);
  }

  return fullPath;
}

function inlineAssetUrls(css) {
  return css.replace(/url\((['"]?)(\/?(fonts|icons)\/([^'")]+))\1\)/g, (_match, _quote, _url, directory, file) => {
    return `url("${assetDataUrl(directory, file)}")`;
  });
}

function inlineRuntimeAssetReferences(js) {
  return ['fonts', 'icons'].reduce((result, directory) => {
    const directoryPath = join(uiBuildDir, directory);

    if (!existsSync(directoryPath)) {
      return result;
    }

    return listFiles(directoryPath).reduce((next, filePath) => {
      const relative = posix.join(directory, filePath.substring(directoryPath.length + 1).replaceAll('\\', '/'));

      return next.replaceAll(relative, assetDataUrlFromPath(filePath));
    }, result);
  }, js);
}

function listFiles(directory) {
  return readdirSync(directory)
    .map((file) => join(directory, file))
    .flatMap((filePath) => (statSync(filePath).isDirectory() ? listFiles(filePath) : [filePath]));
}

function assetDataUrl(directory, file) {
  return assetDataUrlFromPath(join(uiBuildDir, directory, file));
}

function assetDataUrlFromPath(filePath) {
  const extension = extname(filePath).slice(1).toLowerCase();
  const mimeType =
    {
      otf: 'font/otf',
      svg: 'image/svg+xml',
      png: 'image/png',
      ico: 'image/x-icon',
    }[extension] ?? 'application/octet-stream';

  return `data:${mimeType};base64,${readFileSync(filePath).toString('base64')}`;
}
