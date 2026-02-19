# Chrome Web Store 提出文面（日本語）

最終更新: 2026-02-19

## 基本情報

- 拡張機能名: `Web Thread Reader`
- カテゴリ: `Productivity`
- 言語: `日本語`（英語文面は別ファイル）

## Short Description（132文字以内）

Webページ本文やX記事/スレッドを読み上げ。Browser TTSとVoicepeakローカル連携に対応した、ユーザー起動型リーダー。

## Full Description

Web Thread Reader は、現在開いているページの可読テキストを抽出して読み上げる拡張機能です。

主な機能:

- 通常Webページの本文読み上げ
- X（x.com / twitter.com）の記事・スレッド読み上げ
- Browser TTS と Voicepeak（ローカル連携）を選択可能
- Play/Pause/Reset 操作
- タブ遷移後も Browser TTS を継続再生

Xページでは、記事本文を優先して抽出し、広告/おすすめ枠などノイズ要素の読み上げを抑制します。

この拡張機能はユーザー操作時のみ動作するパッシブ設計です。自動投稿・自動操作・バックグラウンド巡回は行いません。

## Single Purpose Description（審査欄）

ユーザーが開いているページ本文（通常Web/X）を抽出し、ローカルで読み上げるための拡張機能です。

## Privacy Practices（回答草案）

- データ販売: いいえ
- 個人データの第三者提供: いいえ
- 認証情報の収集: いいえ
- ページ内容の外部送信: 既定ではしない
- 任意連携: Voicepeak ローカルAPI（ユーザー設定時のみ localhost へ送信）

## Permission Justification（審査メモ）

- `activeTab`: ユーザー操作で選択中タブを対象にするため
- `scripting`: 抽出スクリプト実行のため
- `storage`: 設定保存のため
- `tabs`: 対象タブの解決・再生制御のため
- `offscreen`: タブ遷移後も Browser TTS を継続するため
- `host_permissions`: ページDOM抽出のため（ユーザー起動時のみ）

## What’s New（初回公開または最新版）

- Xページで広告/おすすめ投稿を読み上げ対象から除外
- X記事抽出の安定化
- Play/Pause/Reset 操作の改善

## Store Listing 追加項目（埋める）

- Support URL: `https://github.com/bakemocho/web-thread-reader/issues`
- Homepage URL: `https://github.com/bakemocho/web-thread-reader`
- Privacy Policy URL: `https://github.com/bakemocho/web-thread-reader/blob/main/LEGAL.md`
