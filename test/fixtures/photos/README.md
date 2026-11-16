# Public photo fixtures

`example.heic` is the unchanged public libheif example at commit
[`12a259a5882dd99d45ec5fc77e296a3b620d1e2e`](https://github.com/strukturag/libheif/blob/12a259a5882dd99d45ec5fc77e296a3b620d1e2e/examples/example.heic).
It contains two test stills, 1280 × 854 pixels. Conversion selects the primary still.
The examples' MIT license is included as `LICENSE.libheif`.

SHA-256: `7f8b363e4936c0666a25f64f3a92fda10bd8e5453be4592530b65a55dd98f3f2`.

`example.png` is a small derivative for checking normal PNG passthrough. Reproduce it with ImageMagick:

```sh
convert 'heic:example.heic[0]' -auto-orient -strip jpeg:/tmp/pidge-example.jpg
convert /tmp/pidge-example.jpg -resize 32x32 example.png
```

`message.json` is synthetic Spectrum metadata in the shape the pinned Photon adapter parses. It uses reserved test phone numbers and no real conversations.
