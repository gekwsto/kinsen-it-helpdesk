"use client";
import React, { useMemo, useEffect, useRef, useCallback, useState } from "react";
import { cn } from "@/lib/utils";

export const BackgroundRippleEffect = ({ cellSize = 60 }: { cellSize?: number }) => {
  const [dims, setDims] = useState({ rows: 12, cols: 24 });

  useEffect(() => {
    const update = () => {
      setDims({
        rows: Math.ceil(window.innerHeight / cellSize) + 1,
        cols: Math.ceil(window.innerWidth / cellSize) + 1,
      });
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [cellSize]);

  return (
    <div
      className="absolute inset-0 h-full w-full overflow-hidden"
      style={
        {
          "--cell-border-color": "#0d3352",
          "--cell-fill-color": "#071929",
          "--cell-shadow-color": "#39bfc2",
        } as React.CSSProperties
      }
    >
      <div
        className="absolute inset-0"
        style={{
          maskImage: "linear-gradient(to top right, transparent 10%, black 58%)",
          WebkitMaskImage: "linear-gradient(to top right, transparent 10%, black 58%)",
        }}
      >
        <DivGrid rows={dims.rows} cols={dims.cols} cellSize={cellSize} />
      </div>
    </div>
  );
};

const DivGrid = ({
  rows,
  cols,
  cellSize,
}: {
  rows: number;
  cols: number;
  cellSize: number;
}) => {
  const gridRef = useRef<HTMLDivElement>(null);
  const cleanupRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cells = useMemo(
    () => Array.from({ length: rows * cols }, (_, i) => i),
    [rows, cols],
  );

  // Pure DOM ripple — zero React re-renders on click
  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!gridRef.current) return;
      const rect = gridRef.current.getBoundingClientRect();
      const clickedCol = Math.floor((e.clientX - rect.left) / cellSize);
      const clickedRow = Math.floor((e.clientY - rect.top) / cellSize);
      const ch = gridRef.current.children;

      if (cleanupRef.current) clearTimeout(cleanupRef.current);

      // Frame 1: clear all animations
      requestAnimationFrame(() => {
        for (let i = 0; i < ch.length; i++) {
          (ch[i] as HTMLElement).style.animation = "none";
        }
        // Frame 2: set new animations after browser commits the clear
        requestAnimationFrame(() => {
          let maxDelay = 0;
          for (let i = 0; i < ch.length; i++) {
            const r = Math.floor(i / cols);
            const c = i % cols;
            const dist = Math.hypot(clickedRow - r, clickedCol - c);
            const delay = Math.round(dist * 45);
            const duration = 160 + Math.round(dist * 60);
            (ch[i] as HTMLElement).style.animation =
              `cell-ripple ${duration}ms ease-out ${delay}ms 1 none`;
            if (delay + duration > maxDelay) maxDelay = delay + duration;
          }
          cleanupRef.current = setTimeout(() => {
            if (!gridRef.current) return;
            const c2 = gridRef.current.children;
            for (let i = 0; i < c2.length; i++) {
              (c2[i] as HTMLElement).style.animation = "none";
            }
          }, maxDelay + 50);
        });
      });
    },
    [cellSize, cols],
  );

  return (
    <div
      ref={gridRef}
      onClick={handleClick}
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${cols}, ${cellSize}px)`,
        gridTemplateRows: `repeat(${rows}, ${cellSize}px)`,
        width: cols * cellSize,
        height: rows * cellSize,
      }}
    >
      {cells.map((idx) => (
        <div
          key={idx}
          className={cn(
            "border-[0.5px] opacity-40 will-change-transform",
            "transition-all duration-150",
            "hover:opacity-80 hover:shadow-[0px_0px_30px_2px_var(--cell-shadow-color)_inset]",
          )}
          style={{
            backgroundColor: "var(--cell-fill-color)",
            borderColor: "var(--cell-border-color)",
          }}
        />
      ))}
    </div>
  );
};
