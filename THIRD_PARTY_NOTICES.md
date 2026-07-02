# Third-Party Notices

This project includes source code adapted from third-party open source
projects. These notices apply to source code only; bundled media
provenance is tracked in `assets/PROVENANCE.md`.

## noa-engine

Repository: <https://github.com/fenomas/noa>

License: MIT

Used in: `src/noa`, vendored from noa-engine 0.33 and converted to TypeScript.
The full MIT license text for this vendored code is included at
`src/noa/LICENSE.txt`.

Copyright (c) 2015-2022 Andy Hall (andy@fenomas.com)

## aabb-3d

Repository: <https://github.com/fenomas/aabb-3d>

License: MIT

Used in: vendored local dependency at `vendor/aabb-3d`, consumed by the shared
physics simulation and vendored noa camera code. The MIT license text is
included at `vendor/aabb-3d/LICENSE`.

## box-intersect

Repository: <https://github.com/fenomas/box-intersect>

License: MIT

Used in: vendored local dependency at `vendor/box-intersect`, consumed by the
vendored noa entity-collision system. The MIT license text is included at
`vendor/box-intersect/LICENSE`.

## voxel-physics-engine

Repository: <https://github.com/fenomas/voxel-physics-engine>

License: MIT

Used in: vendored local dependency at `vendor/voxel-physics-engine`, consumed by
the shared character simulation. The MIT license text is included at
`vendor/voxel-physics-engine/LICENSE`.

## skinview3d

Repository: <https://github.com/bs-community/skinview3d>

License: MIT

Used in: `src/client.ts` character box UV unwrapping and selected humanoid
walk/run/idle/swing animation formulas.

The adapted code remains under the following MIT license notice:

MIT License

Copyright (c) 2014-2018 Kent Rasmussen
Copyright (c) 2017-2022 Haowei Wen, Sean Boult and contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
