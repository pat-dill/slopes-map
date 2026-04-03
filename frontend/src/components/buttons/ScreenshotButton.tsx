import clsx from "clsx";
import React from "react";
import html2canvas from "html2canvas";
import download from "downloadjs";

export default function ScreenshotButton({ className }: { className?: string }) {
    return (
        <button
            className={clsx("p-2 w-10 h-10 flex justify-center items-center", className)}
            onClick={async () => {
                const canvas = await html2canvas(document.body);
                download(canvas.toDataURL("image/png"), "map.png", "image/png");
            }}
        >
            <i className="fa fa-camera" />
        </button>
    );
}
