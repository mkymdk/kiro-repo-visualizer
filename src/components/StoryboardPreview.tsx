import React, { useState } from "react";
import {
  DndContext,
  DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { SLIDE_CONFIG } from "../config/output";
import { Slide } from "../types/index";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface StoryboardPreviewProps {
  /** Initial ordered slide array from the storyboard generator. */
  initialSlides: Slide[];
  /** Called with the final user-ordered slide array when export is requested. */
  onExport: (slides: Slide[]) => void;
}

// ---------------------------------------------------------------------------
// SortableSlideCard
// ---------------------------------------------------------------------------

interface SortableSlideCardProps {
  slide: Slide;
  canRemove: boolean;
  onRemove: (id: string) => void;
}

function SortableSlideCard({
  slide,
  canRemove,
  onRemove,
}: SortableSlideCardProps): React.ReactElement {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: slide.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    border: "1px solid #ccc",
    padding: "12px",
    marginBottom: "8px",
    background: "#fff",
    display: "flex",
    alignItems: "flex-start",
    gap: "12px",
  };

  const removeTitle = !canRemove
    ? `Minimum ${SLIDE_CONFIG.minSlides} slides required`
    : `Remove slide: ${slide.title}`;

  return (
    <li ref={setNodeRef} style={style}>
      {/* Drag handle */}
      <button
        type="button"
        aria-label="Drag to reorder"
        {...attributes}
        {...listeners}
        style={{ cursor: "grab", background: "none", border: "none", fontSize: "20px" }}
      >
        ⠿
      </button>

      <div style={{ flex: 1 }}>
        <strong>{slide.title}</strong>
        <p style={{ margin: "4px 0 0", fontSize: "0.875rem", color: "#555" }}>
          {slide.previewSummary}
        </p>
      </div>

      <button
        type="button"
        onClick={() => onRemove(slide.id)}
        disabled={!canRemove}
        aria-label={`Remove slide: ${slide.title}`}
        title={removeTitle}
        style={{ flexShrink: 0 }}
      >
        Remove
      </button>
    </li>
  );
}

// ---------------------------------------------------------------------------
// StoryboardPreview
// ---------------------------------------------------------------------------

/**
 * Step 3 — displays generated slides with drag-to-reorder and remove controls.
 */
export function StoryboardPreview({
  initialSlides,
  onExport,
}: StoryboardPreviewProps): React.ReactElement {
  const [slides, setSlides] = useState<Slide[]>(initialSlides);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const handleDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      setSlides((prev) => {
        const oldIndex = prev.findIndex((s) => s.id === active.id);
        const newIndex = prev.findIndex((s) => s.id === over.id);
        return arrayMove(prev, oldIndex, newIndex);
      });
    }
  };

  const handleRemove = (id: string): void => {
    setSlides((prev) => prev.filter((s) => s.id !== id));
  };

  const canRemove = slides.length > SLIDE_CONFIG.minSlides;

  return (
    <section aria-label="Storyboard preview">
      <h2>Preview &amp; Reorder Slides</h2>
      <p>{slides.length} slide{slides.length !== 1 ? "s" : ""}</p>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={slides.map((s) => s.id)}
          strategy={verticalListSortingStrategy}
        >
          <ol style={{ listStyle: "none", padding: 0 }}>
            {slides.map((slide) => (
              <SortableSlideCard
                key={slide.id}
                slide={slide}
                canRemove={canRemove}
                onRemove={handleRemove}
              />
            ))}
          </ol>
        </SortableContext>
      </DndContext>

      <button
        type="button"
        onClick={() => onExport(slides)}
        disabled={slides.length === 0}
      >
        Export Video
      </button>
    </section>
  );
}

export default StoryboardPreview;
