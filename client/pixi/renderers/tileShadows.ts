import { Container, NineSliceSprite, Sprite } from "pixi.js";
import type { RenderResources } from "../scene/renderTypes";
import { SHADOW_LAYER_Z } from "../geometry/renderConstants";

export class TileShadows {
  constructor(private readonly resources: RenderResources) {}

  makeTileShadow(
    footprint: {
      width: number;
      height: number;
      rotation: number;
      cx: number;
      cy: number;
    },
    screenRotation: number,
    opts?: { big?: boolean }
  ): Sprite | null {
    const factory = this.resources.spriteFactory;
    const store = this.resources.textureStore;
    const shadow = this.resources.tileDesign.effects.shadow;
    if (!factory || !store || !shadow) {
      return null;
    }
    const atlasId = opts?.big
      ? shadow.big
      : footprint.width > footprint.height
        ? shadow.side
        : shadow.small;
    // Match the settled column/basic shadow exactly: fixed `depth`
    // thickness (not the texture's natural aspect) so the flying
    // tile's shadow doesn't read thicker than where it lands.
    const h = footprint.height;
    const w = shadow.depth;
    const s = factory.create({
      atlasId,
      tile: null,
      width: w,
      height: h,
      rotation: footprint.rotation,
      anchor: 0.5,
    });
    if (shadow.alpha !== undefined) {
      s.alpha = shadow.alpha;
    }
    // Stick the shadow's left edge to the tile's right edge, then
    // nudge by the design offset — in screen space, rotated back
    // through the container/wrap rotation.
    const screenDx = footprint.width / 2 + w / 2 + shadow.offsetX;
    const screenDy = shadow.offsetY;
    const cos = Math.cos(screenRotation);
    const sin = Math.sin(screenRotation);
    s.position.set(
      footprint.cx + screenDx * cos + screenDy * sin,
      footprint.cy - screenDx * sin + screenDy * cos
    );
    return s;
  }

  placeTileShadow(
    area: Container,
    shadow: Sprite,
    wrapX: number,
    wrapY: number,
    wrapRotation: number
  ): void {
    const sw = new Container();
    sw.addChild(shadow);
    sw.position.set(wrapX, wrapY);
    sw.rotation = wrapRotation;
    sw.zIndex = SHADOW_LAYER_Z;
    area.addChild(sw);
  }

  placeLineShadow(area: Container, x: number, y: number, length: number): void {
    const store = this.resources.textureStore;
    const shadow = this.resources.tileDesign.effects.shadow;
    if (!store || !shadow || length <= 0) {
      return;
    }
    const tex = store.getTexture(shadow.long, null);
    // Pure 9-slice: fixed native caps (the shadow's soft ends) with the
    // middle repeated. `shadow.cap` is sized to fit both caps in the
    // shortest real column; the min() only guards a degenerate one
    // from overlapping, it isn't a per-length shrink.
    const cap = Math.min(tex.height * shadow.cap, length / 2);
    const ns = new NineSliceSprite({
      texture: tex,
      leftWidth: 0,
      topHeight: cap,
      rightWidth: 0,
      bottomHeight: cap,
    });
    ns.width = shadow.depth; // texture u → +x depth (dark edge → feather right)
    ns.height = length; // texture v → +y column length (middle repeated)
    ns.position.set(x + shadow.offsetX, y + shadow.offsetY);
    ns.zIndex = SHADOW_LAYER_Z;
    if (shadow.alpha !== undefined) {
      ns.alpha = shadow.alpha;
    }
    area.addChild(ns);
  }

  screenShadowLayer(container: Container, rotation: number): Container {
    const layer = new Container();
    layer.rotation = -rotation;
    layer.zIndex = SHADOW_LAYER_Z;
    container.addChild(layer);
    return layer;
  }

  placeBasicShadow(
    layer: Container,
    xRight: number,
    ay: number,
    h: number,
    atlas: string
  ): void {
    const store = this.resources.textureStore;
    const shadow = this.resources.tileDesign.effects.shadow;
    if (!store || !shadow) {
      return;
    }
    const s = new Sprite(store.getTexture(atlas, null));
    s.anchor.set(0, 0.5);
    s.width = shadow.depth;
    s.height = h;
    s.position.set(xRight + shadow.offsetX, ay + shadow.offsetY);
    s.zIndex = SHADOW_LAYER_Z;
    if (shadow.alpha !== undefined) {
      s.alpha = shadow.alpha;
    }
    layer.addChild(s);
  }

  placeUprightShadow(
    layer: Container,
    xRight: number,
    yBottom: number,
    tileH: number,
    atlas: string
  ): void {
    const store = this.resources.textureStore;
    const shadow = this.resources.tileDesign.effects.shadow;
    if (!store || !shadow) {
      return;
    }
    const tex = store.getTexture(atlas, null);
    const s = new Sprite(tex);
    s.anchor.set(0, 1);
    const fit = tex.height > 0 ? tileH / tex.height : 1;
    s.scale.set(fit * (shadow.uprightScale ?? 1));
    s.position.set(xRight + shadow.offsetX, yBottom + shadow.offsetY);
    s.zIndex = SHADOW_LAYER_Z;
    if (shadow.alpha !== undefined) {
      s.alpha = shadow.alpha;
    }
    layer.addChild(s);
  }

  placeColumnShadows(
    layer: Container,
    boxes: ReadonlyArray<{ ax: number; ay: number; w: number; h: number }>,
    bucketByRightEdge = false
  ): void {
    const shadow = this.resources.tileDesign.effects.shadow;
    if (!shadow) {
      return;
    }
    const cols = new Map<
      number,
      Array<{ ax: number; ay: number; w: number; h: number }>
    >();
    for (const b of boxes) {
      const key = Math.round(bucketByRightEdge ? b.ax + b.w / 2 : b.ax);
      const list = cols.get(key);
      if (list) {
        list.push(b);
      } else {
        cols.set(key, [b]);
      }
    }
    for (const list of cols.values()) {
      // Sort top→bottom, then split into contiguous runs so a real gap
      // in the column (e.g. the half-tile dead-wall/live-wall split)
      // breaks the strip instead of being bridged by one continuous
      // shadow. A gap is a centre-to-centre jump well above the
      // column's normal tile pitch.
      list.sort((a, b) => a.ay - b.ay);
      const emitRun = (
        run: Array<{ ax: number; ay: number; w: number; h: number }>
      ): void => {
        if (run.length === 0) {
          return;
        }
        if (run.length === 1) {
          const b = run[0];
          this.placeBasicShadow(
            layer,
            b.ax + b.w / 2,
            b.ay,
            b.h,
            b.w > b.h ? shadow.side : shadow.small
          );
          return;
        }
        let right = -Infinity;
        let top = Infinity;
        let bottom = -Infinity;
        for (const b of run) {
          right = Math.max(right, b.ax + b.w / 2);
          top = Math.min(top, b.ay - b.h / 2);
          bottom = Math.max(bottom, b.ay + b.h / 2);
        }
        this.placeLineShadow(layer, right, top, bottom - top);
      };
      // Normal pitch = median consecutive spacing, robust to a single
      // large gap and to the freshly-discarded tile's +10/+10 nudge.
      const gaps: number[] = [];
      for (let i = 1; i < list.length; i++) {
        gaps.push(list[i].ay - list[i - 1].ay);
      }
      const sortedGaps = [...gaps].sort((a, b) => a - b);
      const pitch =
        sortedGaps.length > 0
          ? sortedGaps[Math.floor(sortedGaps.length / 2)]
          : 0;
      let run: Array<{ ax: number; ay: number; w: number; h: number }> = [];
      for (let i = 0; i < list.length; i++) {
        if (
          i > 0 &&
          pitch > 0 &&
          list[i].ay - list[i - 1].ay > pitch * 1.4 + 1
        ) {
          emitRun(run);
          run = [];
        }
        run.push(list[i]);
      }
      emitRun(run);
    }
  }
}
