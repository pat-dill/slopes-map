import clsx from "clsx";
import React from "react";

export default function ToggleButton({
    value,
    setValue,
    falseIcon,
    trueIcon,
    className,
}: {
    value: boolean;
    setValue: (v: boolean) => void;
    falseIcon?: string;
    trueIcon?: string;
    className?: string;
}) {
    return (
        <button
            className={clsx("p-2 w-10 h-10 flex justify-center items-center", className)}
            onClick={() => {
                setValue(!value);
            }}
        >
            <i
                className={clsx(
                    {
                        [trueIcon as string]: value,
                        [falseIcon as string]: !value,
                    },
                    className
                )}
            />
        </button>
    );
}
