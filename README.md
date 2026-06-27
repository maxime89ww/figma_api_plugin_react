# Figma API Image Generator

## Проверка обновлений через GitLab

1. В `src/plugin/update-config.ts` укажите raw-ссылку на файл `update.json` из вашего GitLab:

```ts
export const UPDATE_MANIFEST_URL =
  'https://gitlab.company.ru/team/project/-/raw/main/update.json';
```

Также добавьте точный HTTPS-домен GitLab в `networkAccess.allowedDomains` файла `manifest.json`. Плагин намеренно не разрешает запросы к произвольным доменам.

2. Добавьте в репозиторий `update.json`:

```json
{
  "version": "1.0.1",
  "downloadUrl": "https://gitlab.company.ru/team/project/-/releases/v1.0.1",
  "notes": "Краткое описание изменений"
}
```

3. Версию установленной сборки меняйте в `package.json`. Поддерживаются версии `1.2.3` и `v1.2.3`.
4. Соберите плагин командой `npm run build`.

Проверка выполняется при запуске и не блокирует работу при недоступности GitLab. Обе ссылки должны использовать HTTPS. Для приватного GitLab файл `update.json` должен быть доступен без токена (например, через GitLab Pages или внутренний endpoint), потому что секрет нельзя безопасно встраивать в Figma-плагин.

Ссылки `update.json` и `downloadUrl` должны использовать один и тот же HTTPS-домен. Это предотвращает перенаправление пользователя на посторонний сайт.

## Команды

```bash
npm run start
npm run test
npm run build
```
