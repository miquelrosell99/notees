import { useEffect, useState } from "react";

import { labelFromClient } from "../../ui/dateDisplay.js";
import { assetImageUrl } from "../collection/assetThumbs.js";
import { Icon } from "../../ui/Icon.js";
import type { AnyClient } from "./shared.js";

/**
 * One linked asset in the asset property list: the thumbnail (image bytes
 * through the session cache; a kind icon otherwise) + the file name (the
 * node_asset original name — clicking downloads) + the remove button. A
 * value whose target is gone renders the broken-reference id honestly
 * (the dashed broken-mention policy), never a silent void.
 */
export function AssetItemRow({
  client,
  assetRef,
  dimmed,
  removable,
  onRemove,
}: {
  client: AnyClient;
  assetRef: string;
  dimmed: boolean;
  removable: boolean;
  onRemove: () => void;
}) {
  const info = client.getAssetInfo(assetRef);
  const name = info?.originalName ?? labelFromClient(client, assetRef) ?? "Untitled";
  const isImage = info !== undefined && info.mimeType.startsWith("image/");
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!isImage) return;
    let alive = true;
    void assetImageUrl(client, assetRef).then((resolved) => {
      if (alive) setUrl(resolved);
    });
    return () => {
      alive = false;
    };
  }, [client, assetRef, isImage]);

  const linkedNode = client.getNode(assetRef);
  const broken = linkedNode === undefined;
  const download = () => {
    if (info !== undefined) void client.downloadAsset(info.assetId);
  };

  return (
    <li
      className={
        dimmed
          ? "nt-asset-item nt-asset-item--default"
          : broken
            ? "nt-asset-item nt-asset-item--broken"
            : "nt-asset-item"
      }
      title={broken ? `Broken reference: ${assetRef}` : undefined}
    >
      {broken ? (
        <span className="nt-asset-item__thumb nt-asset-item__thumb--broken" aria-hidden="true">
          <Icon path="mdi-file-question-outline" size={0.8} />
        </span>
      ) : isImage ? (
        url !== null ? (
          <img className="nt-asset-item__thumb" src={url} alt="" draggable="false" />
        ) : (
          <span className="nt-asset-item__thumb" aria-hidden="true">
            <Icon path="mdi-image-outline" size={0.8} />
          </span>
        )
      ) : (
        <span className="nt-asset-item__thumb" aria-hidden="true">
          <Icon
            path={
              info !== undefined && info.mimeType.startsWith("audio/")
                ? "mdi-music-note-outline"
                : "mdi-file-outline"
            }
            size={0.8}
          />
        </span>
      )}
      {broken ? (
        <span className="nt-asset-item__name nt-asset-item__name--broken">
          <code>{assetRef}</code>
        </span>
      ) : (
        <button
          type="button"
          className="nt-asset-item__name"
          title="Download"
          onClick={download}
        >
          {name}
        </button>
      )}
      {removable && !broken && (
        <button
          type="button"
          className="nt-asset-item__remove"
          aria-label={`Remove ${name}`}
          onClick={onRemove}
        >
          <Icon path="mdi-close" size={0.7} />
        </button>
      )}
    </li>
  );
}
