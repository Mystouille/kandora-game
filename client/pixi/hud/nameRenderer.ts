import {
  Assets,
  Container,
  Graphics,
  Sprite,
  Text,
  TextStyle,
  type Texture,
} from "pixi.js";
import type {
  RenderFrame,
  RenderResources,
  SeatEnrichment,
} from "../scene/renderTypes";
import type { Seat } from "../tableGeometry";
import { duplicatePlayerCounterSpecs } from "../panels/duplicateCounterPlan";
import { playerIdentityCenter } from "../geometry/tableGeometry";
import {
  PLAYER_PANEL_CONTENT_Z,
  PLAYER_PANEL_SIZE,
  SEAT_CONTAINER_ROT,
} from "../geometry/renderConstants";
import type { CenterLabels, DiscardPanelRects } from "./hudTypes";

export class NameRenderer {
  private seatEnrichment: (SeatEnrichment | null)[] = [null, null, null, null];
  private readonly teamLogoTextures = new Map<string, Texture>();
  private readonly teamLogoPending = new Set<string>();
  private loadGeneration = 0;

  constructor(private readonly requestRender: () => void) {}

  setSeatEnrichment(list: (SeatEnrichment | null)[]): void {
    this.seatEnrichment = [
      list[0] ?? null,
      list[1] ?? null,
      list[2] ?? null,
      list[3] ?? null,
    ];
    this.requestRender();
  }

  private ensureTeamLogo(url: string): Texture | null {
    const cached = this.teamLogoTextures.get(url);
    if (cached) {
      return cached;
    }
    if (!this.teamLogoPending.has(url)) {
      this.teamLogoPending.add(url);
      const generation = this.loadGeneration;
      void Assets.load<Texture>(url)
        .then((texture) => {
          if (generation !== this.loadGeneration) {
            return;
          }
          this.teamLogoTextures.set(url, texture);
          this.teamLogoPending.delete(url);
          this.requestRender();
        })
        .catch((error) => {
          if (generation === this.loadGeneration) {
            this.teamLogoPending.delete(url);
            // eslint-disable-next-line no-console
            console.warn("[TableRenderer] failed to load team logo", error);
          }
        });
    }
    return null;
  }

  render(
    frame: RenderFrame,
    resources: RenderResources,
    discardPanels: DiscardPanelRects,
    labels: CenterLabels
  ): void {
    const { view, root } = frame;
    if (!view.seatNames) {
      return;
    }
    const fontSize = 14;
    const padY = 4;
    const buuMode = view.buuMode === true;
    const duplicateCounters = new Map(
      duplicatePlayerCounterSpecs(view.duplicateWallState).map((counter) => [
        counter.seat,
        counter,
      ])
    );
    const addRemainingCounter = (
      target: Container,
      text: Text,
      y: number
    ): void => {
      const width = Math.ceil(text.width) + 10;
      const height = Math.ceil(text.height) + 4;
      const background = new Graphics()
        .roundRect(-width / 2, -height / 2, width, height, 4)
        .fill({ color: 0x000000, alpha: 0.68 });
      const badge = new Container();
      badge.addChild(background, text);
      badge.position.set(0, y);
      target.addChild(badge);
    };
    type Built = {
      seat: Seat;
      nameText: Text;
      chipText: Text | null;
      remainingText: Text | null;
      teamLogoTex: Texture | null;
      isDisconnected: boolean;
      hasDabuken: boolean;
    };
    const built: Built[] = [];
    let maxChipTextW = 0;
    let maxNameH = 0;
    let maxRemainingTextH = 0;
    for (let seat = 0; seat < 4; seat++) {
      const name = view.seatNames[seat];
      if (!name) {
        continue;
      }
      const occupant = view.roomState?.seats[seat]?.occupant;
      const isDisconnected =
        occupant !== undefined &&
        occupant !== null &&
        occupant.kind === "human" &&
        occupant.connected === false;
      const nameText = new Text({
        text: name,
        style: new TextStyle({
          fontFamily: "Inter, system-ui, sans-serif",
          fontSize,
          fontWeight: "700",
          fill: 0xffffff,
          stroke: { color: 0x000000, width: 4, join: "round" },
        }),
      });
      nameText.anchor.set(0.5, 0.5);
      const maxNameWidth = PLAYER_PANEL_SIZE - 16;
      if (nameText.width > maxNameWidth) {
        nameText.scale.set(maxNameWidth / nameText.width);
      }
      maxNameH = Math.max(maxNameH, Math.ceil(nameText.height));
      let chipText: Text | null = null;
      if (buuMode) {
        chipText = new Text({
          text: String(view.chips[seat] ?? 0),
          style: new TextStyle({
            fontFamily: "Inter, system-ui, sans-serif",
            fontSize: 13,
            fontWeight: "700",
            fill: 0xfde68a,
          }),
        });
        chipText.anchor.set(0.5, 0.5);
        maxChipTextW = Math.max(maxChipTextW, Math.ceil(chipText.width));
      }
      const duplicateCounter = duplicateCounters.get(seat as Seat);
      let remainingText: Text | null = null;
      if (duplicateCounter) {
        remainingText = new Text({
          text: `${labels.remainingDraws}: ${duplicateCounter.remaining}`,
          style: new TextStyle({
            fontFamily: "Inter, system-ui, sans-serif",
            fontSize: 10,
            fontWeight: duplicateCounter.limiting ? "700" : "600",
            fill: duplicateCounter.color,
          }),
        });
        remainingText.anchor.set(0.5, 0.5);
        const maxCounterWidth = PLAYER_PANEL_SIZE - 16;
        if (remainingText.width > maxCounterWidth) {
          remainingText.scale.set(maxCounterWidth / remainingText.width);
        }
        maxRemainingTextH = Math.max(
          maxRemainingTextH,
          Math.ceil(remainingText.height)
        );
      }
      let teamLogoTex: Texture | null = null;
      const enrichment = this.seatEnrichment[seat];
      if (enrichment?.teamLogoUrl) {
        teamLogoTex = this.ensureTeamLogo(enrichment.teamLogoUrl);
      }
      built.push({
        seat: seat as Seat,
        nameText,
        chipText,
        remainingText,
        teamLogoTex,
        isDisconnected,
        hasDabuken: buuMode && view.dabuken[seat] === true,
      });
    }
    if (built.length === 0) {
      return;
    }
    const nameRowH = maxNameH + padY * 2;
    const chipIconR = 14;
    const chipIconGap = 4;
    const chipRowH = buuMode ? Math.max(maxNameH, chipIconR * 2) + 4 : 0;
    const dabukenR = 26;
    const dabukenRowH = buuMode ? dabukenR * 2 + 4 : 0;
    const remainingRowH = maxRemainingTextH > 0 ? maxRemainingTextH + 6 : 0;
    const chipLineW = buuMode ? chipIconR * 2 + chipIconGap + maxChipTextW : 0;
    const h = nameRowH + chipRowH + dabukenRowH + remainingRowH;
    const nameCY = -h / 2 + nameRowH / 2;
    const chipCY = -h / 2 + nameRowH + chipRowH / 2;
    const dabukenCY = -h / 2 + nameRowH + chipRowH + dabukenRowH / 2;
    const remainingCY =
      -h / 2 + nameRowH + chipRowH + dabukenRowH + remainingRowH / 2;
    for (const entry of built) {
      const {
        seat,
        nameText,
        chipText,
        remainingText,
        isDisconnected,
        hasDabuken,
      } = entry;
      const center = playerIdentityCenter(discardPanels, seat);
      const container = new Container();
      if (entry.teamLogoTex) {
        const size = PLAYER_PANEL_SIZE;
        const mask = new Graphics()
          .roundRect(-size / 2, -size / 2, size, size, 8)
          .fill(0xffffff);
        const logo = new Sprite(entry.teamLogoTex);
        logo.anchor.set(0.5, 0.5);
        const scale = Math.min(
          size / entry.teamLogoTex.width,
          size / entry.teamLogoTex.height
        );
        logo.width = entry.teamLogoTex.width * scale;
        logo.height = entry.teamLogoTex.height * scale;
        logo.mask = mask;
        container.addChild(mask, logo);
        nameText.position.set(0, size / 2 - nameText.height / 2 - 8);
        container.addChild(nameText);
        const teamName = this.seatEnrichment[seat]?.teamName;
        if (teamName) {
          const text = new Text({
            text: teamName,
            style: new TextStyle({
              fontFamily: "Inter, system-ui, sans-serif",
              fontSize: 14,
              fontWeight: "600",
              fill: 0xffffff,
            }),
          });
          text.anchor.set(0.5, 0.5);
          const width = Math.ceil(text.width) + 10;
          const height = Math.ceil(text.height) + 4;
          const background = new Graphics()
            .roundRect(-width / 2, -height / 2, width, height, 4)
            .fill({ color: 0x000000, alpha: 0.6 })
            .stroke({ color: 0xffffff, width: 1, alpha: 0.3 });
          const box = new Container();
          box.addChild(background, text);
          box.position.set(0, -size / 2 + height / 2 + 4);
          container.addChild(box);
        }
        if (remainingText) {
          addRemainingCounter(container, remainingText, 0);
        }
        container.rotation = SEAT_CONTAINER_ROT[seat];
        container.position.set(center.x, center.y);
        container.zIndex = PLAYER_PANEL_CONTENT_Z;
        root.addChild(container);
        continue;
      }
      nameText.position.set(0, nameCY);
      container.addChild(nameText);
      if (buuMode && chipText) {
        const iconCX = -chipLineW / 2 + chipIconR;
        let icon: Container;
        if (resources.chipIconTex) {
          const sprite = new Sprite(resources.chipIconTex);
          sprite.anchor.set(0.5, 0.5);
          sprite.width = chipIconR * 2;
          sprite.height = chipIconR * 2;
          icon = sprite;
        } else {
          icon = new Graphics()
            .circle(0, 0, chipIconR)
            .fill({ color: 0xfacc15 })
            .stroke({ color: 0xffffff, width: 1, alpha: 0.9 })
            .circle(0, 0, chipIconR - 3)
            .stroke({ color: 0xffffff, width: 1, alpha: 0.6 });
        }
        icon.position.set(iconCX, chipCY);
        container.addChild(icon);
        chipText.position.set(
          iconCX + chipIconR + chipIconGap + Math.ceil(chipText.width) / 2,
          chipCY
        );
        container.addChild(chipText);
      }
      if (hasDabuken) {
        let token: Container;
        if (resources.dabukenIconTex) {
          const sprite = new Sprite(resources.dabukenIconTex);
          sprite.anchor.set(0.5, 0.5);
          sprite.width = dabukenR * 2;
          sprite.height = dabukenR * 2;
          token = sprite;
        } else {
          const disc = new Graphics()
            .circle(0, 0, dabukenR)
            .fill({ color: 0xdc2626 })
            .stroke({ color: 0xffffff, width: 1.5, alpha: 0.95 })
            .circle(0, 0, dabukenR - 4)
            .stroke({ color: 0xffffff, width: 1, alpha: 0.7 });
          const text = new Text({
            text: "x2",
            style: new TextStyle({
              fontFamily: "Inter, system-ui, sans-serif",
              fontSize: 12,
              fontWeight: "800",
              fill: 0xffffff,
            }),
          });
          text.anchor.set(0.5, 0.5);
          const marker = new Container();
          marker.addChild(disc, text);
          token = marker;
        }
        token.position.set(0, dabukenCY);
        container.addChild(token);
      }
      if (remainingText) {
        addRemainingCounter(container, remainingText, remainingCY);
      }
      if (isDisconnected) {
        const text = new Text({
          text: "DC",
          style: new TextStyle({
            fontFamily: "Inter, system-ui, sans-serif",
            fontSize: 10,
            fontWeight: "700",
            fill: 0xffffff,
            letterSpacing: 0.5,
          }),
        });
        text.anchor.set(0.5, 0.5);
        const width = Math.ceil(text.width) + 8;
        const height = Math.ceil(text.height) + 2;
        const background = new Graphics()
          .roundRect(-width / 2, -height / 2, width, height, 4)
          .fill({ color: 0xb91c1c, alpha: 0.95 })
          .stroke({ color: 0xffffff, width: 1, alpha: 0.6 });
        const badge = new Container();
        badge.addChild(background, text);
        badge.position.set(0, h / 2 + height / 2 + 2);
        container.addChild(badge);
      }
      if (remainingRowH > 0 && h > PLAYER_PANEL_SIZE - 8) {
        container.scale.set((PLAYER_PANEL_SIZE - 8) / h);
      }
      container.rotation = SEAT_CONTAINER_ROT[seat];
      container.position.set(center.x, center.y);
      container.zIndex = PLAYER_PANEL_CONTENT_Z;
      root.addChild(container);
    }
  }

  destroy(): void {
    this.loadGeneration++;
    this.teamLogoPending.clear();
    // Retain loaded logos across facade remounts; Assets owns their sources.
  }
}
