import clsx from "clsx";
import React, { useRef, useState } from "react";
import { useAnimationFrame } from "pat-web-utils";
import { useCopyToClipboard } from "usehooks-ts";
import { useLocation } from "react-router-dom";

export default function ShareButton({ url, className }: { url?: string; className?: string }) {
    const [copiedAt, setCopiedAt] = useState(-Infinity);
    const [showCheck, setShowCheck] = useState(false);
    const currentUrl = useRef(window.location.href);
    const [_, copyToClipboard] = useCopyToClipboard();

    useAnimationFrame(() => {
        setShowCheck(performance.now() - copiedAt <= 1000);
        currentUrl.current = window.location.href;
    });

    return (
        <button
            className={clsx("p-2 w-10 h-10 flex justify-center items-center", className)}
            onClick={async () => {
                if (navigator.share) {
                    await navigator.share({ url: url ?? currentUrl.current });
                } else {
                    await copyToClipboard(url ?? currentUrl.current);
                    setCopiedAt(performance.now());
                }
            }}
        >
            <i
                className={clsx({
                    "fa fa-share": !showCheck && !!navigator.share,
                    "fa fa-link": !showCheck && !navigator.share,
                    "fa fa-check": showCheck,
                })}
            />
        </button>
    );
}
