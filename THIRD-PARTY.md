# Third-Party Notices

## Matinee motion engine

`src/motion.ts` derives its minimum-jerk, Bézier-path, overshoot, tremor, and
seeded random-number behavior from
[benhowdle89/matinee](https://github.com/benhowdle89/matinee),
[`src/motion.ts`](https://github.com/benhowdle89/matinee/blob/e5c9608a36aa46b5815cc0eee117dc3114db5536/src/motion.ts),
commit `e5c9608a36aa46b5815cc0eee117dc3114db5536`.

The source is licensed under the [MIT License](https://github.com/benhowdle89/matinee/blob/e5c9608a36aa46b5815cc0eee117dc3114db5536/LICENSE), Copyright (c) 2026 Ben Howdle. The retained license notice in `src/motion.ts` applies to the derived code.

## Screen Studio Effects zoom spring and rest detection

`src/render/spring.ts`, `src/render/rest.ts` and the `screenToVideoUV`
function in `src/render/cursor.ts` derive from
[pythonlearner1025/Screen-Studio-Effects](https://github.com/pythonlearner1025/Screen-Studio-Effects),
files
[`src/spring.ts`](https://github.com/pythonlearner1025/Screen-Studio-Effects/blob/bcaa05c2a39e7ccb4d747bba936f93f15350bc0a/src/spring.ts),
[`src/zoom.ts`](https://github.com/pythonlearner1025/Screen-Studio-Effects/blob/bcaa05c2a39e7ccb4d747bba936f93f15350bc0a/src/zoom.ts),
[`src/auto-zoom.ts`](https://github.com/pythonlearner1025/Screen-Studio-Effects/blob/bcaa05c2a39e7ccb4d747bba936f93f15350bc0a/src/auto-zoom.ts)
and
[`src/cursor.ts`](https://github.com/pythonlearner1025/Screen-Studio-Effects/blob/bcaa05c2a39e7ccb4d747bba936f93f15350bc0a/src/cursor.ts),
commit `bcaa05c2a39e7ccb4d747bba936f93f15350bc0a`.

The source is licensed under the [MIT License](https://github.com/pythonlearner1025/Screen-Studio-Effects/blob/bcaa05c2a39e7ccb4d747bba936f93f15350bc0a/LICENSE), Copyright (c) 2025 Blitz. The retained license notices in the files above apply to the derived code. The upstream files themselves credit [Cap](https://github.com/CapSoftware/Cap) as their own origin.

Three things changed on adoption, all of them parameters that were constants upstream:

- `springEase`/`springEaseOut` in upstream `src/zoom.ts` hard-wire one stiffness/damping/mass triple and a scaled copy of it. Here the triple is an argument (`springEase(progress, config)`, `relaxSpring(config)`).
- `screenToVideoUV` in upstream `src/cursor.ts:45-46` reads `const videoX = (x - transform.windowX) * 2`, a silent assumption that the capture is twice the size of its coordinate space. That factor is now `transform.pixelRatio`.
- `detectSilenceZones` in upstream `src/auto-zoom.ts` hard-wires a 2px threshold and takes nanosecond timestamps. Both are arguments, and time is the renderer's millisecond clock.

The stateful viewport-panning spring from upstream `src/zoom.ts` was deliberately **not** adopted: it exists to chase a live cursor across a recorded screen, whereas our zoom targets are the logged bounding boxes of the elements that were actually hit, which are known ahead of time and must not move while the element animates.
