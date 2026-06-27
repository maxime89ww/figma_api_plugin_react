# Figma API Image Generator

Плагин Figma для генерации и редактирования изображений через Polza AI.

## Установка плагина

### 4. Соберите плагин

```bash
npm run build
```

После успешной сборки появятся файлы `dist/plugin/code.js` и `dist/ui.html`.

### 5. Подключите плагин к Figma

1. Откройте Figma Desktop и любой дизайн-файл.
2. Откройте меню **Plugins → Development → Import plugin from manifest**.
3. Выберите файл `manifest.json` в корне скачанного проекта.
4. Подтвердите импорт.

### 6. Запустите плагин

1. Откройте **Plugins → Development → Figma API Image Generator**.
2. Нажмите кнопку с иконкой ключа.
3. Введите API-ключ Polza AI и нажмите **Сохранить**.
4. Введите описание изображения и нажмите **Harvest!**.

API-ключ сохраняется локально средствами Figma и не записывается в репозиторий.

## Обновление локальной версии

```bash
git pull
npm ci
npm run build
```

После сборки закройте запущенный экземпляр плагина и откройте его снова в Figma.

## Разработка

```bash
npm install
npm run start
```

## Проверка и сборка

```bash
npm run test
npm run build
```
