# Сертификаты для исходящего TLS

`tbank-ca.pem` содержит публичные RSA-сертификаты НУЦ для проверки сервера Т-Инвестиций. Первый PEM-блок содержит корневой сертификат, следующие два — выпускающие. Копии для этой версии получены из [зеркала](https://github.com/SergeAx/russian-ca-hosts/tree/master/certs). При сборке файла проверены SHA-256 каждого сертификата в формате DER, подпись корневого сертификата и подписи обоих выпускающих сертификатов его ключом. Страницы официальной публикации — [Госуслуги](https://www.gosuslugi.ru/crt) и [Т-Банк, раздел Linux](https://status.tbank-online.com/certificates/).

| Сертификат | Действует до, UTC | SHA-256 от DER |
| --- | --- | --- |
| Russian Trusted Root CA | 2032-02-27 | `d26d2d0231b7c39f92cc738512ba54103519e4405d68b5bd703e9788ca8ecf31` |
| Russian Trusted Sub CA, 2022 | 2027-03-06 | `bbbde2103e790b999ec62bd03cf625a5a2e7c316e10afe6a490eedead8b3fd9b` |
| Russian Trusted Sub CA, 2024 | 2029-07-19 | `2155785036c900dbb5f1bb2a1569c80c55595bd6bf94867a29bbddbc7d88a3f2` |

Для независимой сверки доступны [отпечаток корня в сервисе просмотра CT](https://ct.tlscc.ru/?id=1&opt=nometadata), [запись выпускающего сертификата 2024 года](https://ct.tlscc.ru/?id=11606) и [таблица всех трёх отпечатков](https://pasw.su/russian-trusted-ca/). Банк указывает контуры и требования именно для инвестиций в [документации подключения](https://developer.tbank.ru/invest/intro/developer/network).

## Сверка и обновление

1. Скачайте актуальные RSA-сертификаты со страницы Т-Банка или Госуслуг в отдельный каталог. Сохраните корень как `root.pem`, выпускающие сертификаты как `sub-2022.pem` и `sub-2024.pem`. Если загрузили DER, преобразуйте его командой `openssl x509 -inform DER -in файл.cer -out файл.pem`.
2. В этом каталоге выполните команды ниже. Сравните отпечатки с таблицей, а при ротации — с данными, полученными по независимому доверенному каналу. Проверьте у каждого `CA:TRUE` и сроки действия.
3. После проверки соберите файл командой `cat root.pem sub-2022.pem sub-2024.pem > tbank-ca.pem`. При плановой ротации обновите состав и таблицу одним коммитом, пересоберите образ. Выполните проверку TLS из сети развёртывания. Для проверки песочницы подставьте её официальное имя в обе позиции.

```sh
for f in root.pem sub-2022.pem sub-2024.pem; do
  openssl x509 -in "$f" -noout -subject -issuer -dates -fingerprint -sha256 -ext basicConstraints
done
openssl verify -no-CApath -no-CAstore -check_ss_sig -CAfile root.pem root.pem sub-2022.pem sub-2024.pem
```

Команда ниже проверяет цепочку и DNS-имя боевого API только по подготовленному набору сертификатов. Ей нужны OpenSSL 3 и сетевой доступ к банку. Банковский токен для TLS-проверки не нужен.

```sh
openssl s_client -connect invest-public-api.tbank.ru:443 \
  -servername invest-public-api.tbank.ru -verify_hostname invest-public-api.tbank.ru \
  -verify_return_error -no-CApath -no-CAstore -CAfile tbank-ca.pem -brief </dev/null
```
