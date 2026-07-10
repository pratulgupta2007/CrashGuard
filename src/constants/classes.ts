/**
 * COCO 80-class label map used by the YOLOv8n model
 * (assets/models/yolov8n.tflite). The model's class index (0..79) maps directly
 * into this array (0 = person, 2 = car, 5 = bus, 7 = truck, ...).
 *
 * NOTE: this is the 80-class list (no gaps), which differs from EfficientDet's
 * 90-class map — animal indices in particular are shifted.
 */
export const COCO_LABELS: string[] = [
  'person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train',
  'truck', 'boat', 'traffic light', 'fire hydrant', 'stop sign',
  'parking meter', 'bench', 'bird', 'cat', 'dog', 'horse', 'sheep', 'cow',
  'elephant', 'bear', 'zebra', 'giraffe', 'backpack', 'umbrella', 'handbag',
  'tie', 'suitcase', 'frisbee', 'skis', 'snowboard', 'sports ball', 'kite',
  'baseball bat', 'baseball glove', 'skateboard', 'surfboard', 'tennis racket',
  'bottle', 'wine glass', 'cup', 'fork', 'knife', 'spoon', 'bowl', 'banana',
  'apple', 'sandwich', 'orange', 'broccoli', 'carrot', 'hot dog', 'pizza',
  'donut', 'cake', 'chair', 'couch', 'potted plant', 'bed', 'dining table',
  'toilet', 'tv', 'laptop', 'mouse', 'remote', 'keyboard', 'cell phone',
  'microwave', 'oven', 'toaster', 'sink', 'refrigerator', 'book', 'clock',
  'vase', 'scissors', 'teddy bear', 'hair drier', 'toothbrush',
];

/**
 * Classes relevant to a driving collision-warning system — vehicles, people,
 * bikes, and animals that may wander onto the road (from the original project).
 */
export const RELEVANT_CLASS_IDS: ReadonlySet<number> = new Set<number>([
  0,  // person
  1,  // bicycle
  2,  // car
  3,  // motorcycle
  5,  // bus
  7,  // truck
  14, // bird
  15, // cat
  16, // dog
  17, // horse
  18, // sheep
  19, // cow
  20, // elephant
  21, // bear
]);

/**
 * Approximate real-world HEIGHT (metres) per relevant class, used in Phase 3 to
 * convert a detection's pixel height into a metric distance via the pinhole
 * model: distance = focal_px * realHeight / boxHeight_px. Rough averages.
 */
export const CLASS_REAL_HEIGHT_M: Record<number, number> = {
  0: 1.7,  // person
  1: 1.7,  // bicycle + rider
  2: 1.5,  // car
  3: 1.5,  // motorcycle + rider
  5: 3.2,  // bus
  7: 3.2,  // truck
  14: 0.3, // bird
  15: 0.3, // cat
  16: 0.5, // dog
  17: 1.6, // horse
  18: 1.0, // sheep
  19: 1.5, // cow
  20: 3.0, // elephant
  21: 1.2, // bear
};

export function labelFor(classId: number): string {
  return COCO_LABELS[classId] ?? `class ${classId}`;
}
