# ローカルRAWの段階open

対象は公開NIHO photoの「このMac」です。クラウドライブラリには追加APIを要求せず、既存の作業コピー経路を使います。

## 編集と保存

`previewOnly → proxyInteractive → canonicalReady` の順に開きます。専用の長辺1600px Quick Look画像を暫定sRGB入力として段2へ渡し、256pxの一覧画像を拡大しません。取得できない・長辺1280px未満・時間切れの場合は従来の正規RAW入力を待ちます。Quick Lookは機種やmacOSによってフルdecodeを起こすため、常に2秒を保証するAPIではありません。

正規入力は従来と同じ2560px・16bit・linear ProPhoto・signed RAWのまま並行生成します。暫定入力は`provisional`で区別し、RAWのbaseVersionを付けません。300ms続く待機には「高画質表示を準備中」を表示します。

補正値は暫定段階から編集できます。内容hashに結び付く、設定だけの端末内draftへ直列保存し、写真切替・終了時にflushします。正規入力を実際に開くまで通常保存・画像uploadを行いません。正規入力で最新の画を描き終えた後に、engine・session・canvasをまとめて替えます。補正値、preset選択と適用量、crop、undo/redoを保ち、構造metadataだけを正規入力へ結び直します。通常保存が成功した世代に対応するdraftだけを消します。

正規生成の失敗後も暫定編集とdraftを保ち、再読込では正規側だけを再試行します。補正を書き込む書出しは正規入力を待ち、準備中を表示します。RAW原本のバイトコピーは待ちません。

暫定画像は正規作業コピーと別cache・queueを持ちます。表示対象は古い暫定jobを止めて優先し、同一内容の処理をまとめます。idle先読みは隣接各1枚に限ります。利用者の画像、元の名前、パス、画像由来のhashを公開計測結果へ出しません。

## 検証と性能の読み方

`use-browser-photo-open.test.tsx` は実hookで、暫定編集、draft、正規切替、preset量、crop、履歴、遅い旧frame、失敗と再試行、写真切替を検査します。`use-browser-photo-export-delete.test.tsx` は実controllerで書出しの待機境界を検査します。ライブラリのテストはnativeキャンセルと内容hashの分離を検査します。

`photoDevelopPerf=1` をcamera rootのURLに付けると、区間だけの診断を明示的に有効化できます。native producer単体の時間とUIの`timeToEditable`は別の測定です。後者はT0から、露光と同梱presetの入力が状態へ反映され、変更後canvasが描画されたところまでを測ります。

集計入口は`node apps/camera/scripts/measure-progressive-open.mjs --case dc-s5=<非公開入力> --probe <実測probe> --probe-arg ... --runs 20`です。probeへ`{input}`、`{cache}`、`{condition}`、`{iteration}`を渡せます。coldは反復ごとにアプリcacheを空にし、warmは保持します。OS file cacheは落としません。probeは渡されたcache領域を実際に使う必要があります。mockの反復やnative producerだけの計測をUIの性能受入値に読み替えません。

MacBook Air M2 / 8GBのcold p50 1秒・p95 2秒、warm p95 500ms、および入力100ms・描画p95 300msが性能受入条件です。Studioの実測はその代替にはしません。実機受入と非公開側のexact SHA取込み・署名・本番配布は別途行います。
