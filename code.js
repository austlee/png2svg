// PNG 2 SVG Tracer - Figma Plugin
// Traces the edges of non-transparent parts of PNG images and creates stroked paths

// Show UI
figma.showUI(__html__, { width: 400, height: 600 });

// Helper functions for UI communication
function sendToUI(type, data) {
  figma.ui.postMessage({ type, data });
}

function log(message, level = 'info') {
  sendToUI('addLog', { message, level });
}

function updateStatus(status, message, timeoutSeconds = null) {
  sendToUI('updateStatus', { status, message, timeoutSeconds });
}

function updateProgress(progress) {
  sendToUI('updateProgress', { progress });
}

// Store PNG decode promise resolver/rejector
let pngDecodeResolve = null;
let pngDecodeReject = null;

// Store density setting (target number of points)
let pathDensity = 10; // Default: 10 points

// Store max dimension for downscaling (to reduce edge pixels)
// Max dimension of 150 means images larger than 150x150 will be downscaled
// This dramatically reduces edge pixels for efficient processing
let maxDimension = 150; // Default: 150 pixels max dimension

// Store reference to last created vector path for undo
let lastCreatedVectorPath = null;

// Style settings (persisted)
let styleSettings = {
  strokeColor: { r: 0, g: 0, b: 0 },
  strokeColorVariableId: null,
  fillColor: null,
  fillColorVariableId: null,
  strokeThickness: 2,
  dropShadow: {
    enabled: false,
    x: 0,
    y: 0,
    blur: 0,
    color: { r: 0, g: 0, b: 0, a: 1 },
    colorVariableId: null,
    opacity: 1
  },
  cornerRadius: 0
};

// Deep-merge helper (no spread for plugin runtime compatibility)
function deepMerge(target, source) {
  const result = Object.assign({}, target);
  for (const key in source) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      const val = source[key];
      if (val && typeof val === 'object' && !Array.isArray(val) && val.constructor === Object) {
        result[key] = deepMerge(target[key] || {}, val);
      } else {
        result[key] = val;
      }
    }
  }
  return result;
}

// Load saved settings from clientStorage
async function loadSettings() {
  try {
    const savedDensity = await figma.clientStorage.getAsync('pathDensity');
    if (savedDensity !== undefined) {
      pathDensity = savedDensity;
      log(`Loaded saved path density: ${pathDensity}`, 'info');
    }
    const savedStyles = await figma.clientStorage.getAsync('styleSettings');
    if (savedStyles !== undefined) {
      styleSettings = deepMerge(styleSettings, savedStyles);
      log('Loaded saved style settings', 'info');
    }
  } catch (error) {
    log(`Error loading settings: ${error.message}`, 'warning');
  }
}

// Save settings to clientStorage
async function saveSettings() {
  try {
    await figma.clientStorage.setAsync('pathDensity', pathDensity);
    await figma.clientStorage.setAsync('styleSettings', styleSettings);
    log(`Saved settings`, 'info');
  } catch (error) {
    log(`Error saving settings: ${error.message}`, 'warning');
  }
}

// Load settings when plugin starts
loadSettings().then(async () => {
  // Send saved density to UI
  sendToUI('setDensity', { density: pathDensity });
  // Send color variables and style settings
  const colorVariables = await getColorVariables();
  sendToUI('setColorVariables', { variables: colorVariables });
  sendToUI('setStyleSettings', { settings: styleSettings });
});

// Wait for message from UI
figma.ui.onmessage = async (msg) => {
  if (msg.type === 'startTracing') {
    pathDensity = msg.density || 10; // Get target point count from UI
    maxDimension = msg.maxDimension || 150; // Get max dimension from UI
    // Merge incoming style settings from UI if provided
    if (msg.styleSettings) {
      styleSettings = deepMerge(styleSettings, msg.styleSettings);
    }
    // Save the new density setting
    await saveSettings();
    await startTracing();
  } else if (msg.type === 'updateDensity') {
    // Save density when user changes the slider
    pathDensity = msg.density || 10;
    await saveSettings();
  } else if (msg.type === 'updateStyleSettings') {
    styleSettings = deepMerge(styleSettings, msg.settings || {});
    await saveSettings();
  } else if (msg.type === 'getColorVariables') {
    const vars = await getColorVariables();
    sendToUI('setColorVariables', { variables: vars });
  } else if (msg.type === 'resolveColorVariable') {
    const color = await resolveColorVariable(msg.variableId);
    sendToUI('colorVariableResolved', { variableId: msg.variableId, color });
  } else if (msg.type === 'undo') {
    // Remove the last created vector path
    await undoLastTracing();
  } else if (msg.type === 'pngDecoded') {
    if (pngDecodeResolve) {
      pngDecodeResolve(msg.data);
      pngDecodeResolve = null;
      pngDecodeReject = null;
    }
  } else if (msg.type === 'pngDecodeError') {
    if (pngDecodeReject) {
      pngDecodeReject(new Error(msg.error));
      pngDecodeResolve = null;
      pngDecodeReject = null;
    }
  }
};

async function startTracing() {
  try {
    updateStatus('info', 'Checking selection...');
    updateProgress(10);
    log('Starting PNG tracing...', 'info');
    
    // Check if an image is selected
    if (figma.currentPage.selection.length === 0) {
      updateStatus('error', 'No selection');
      sendToUI('error', { message: 'Please select an image to trace' });
      log('Error: No selection', 'error');
      return;
    }
    
    const selection = figma.currentPage.selection[0];
    log(`Selected node type: ${selection.type}`, 'info');
    
    // Get node name and parent frame information
    const nodeName = selection.name || 'Unnamed';
    const parentFrame = selection.parent && selection.parent.type === 'FRAME' ? selection.parent : null;
    const frameName = parentFrame ? parentFrame.name : 'None';
    const parentName = selection.parent ? selection.parent.name : 'None';
    
    log(`Node name: "${nodeName}"`, 'info');
    log(`Parent: "${parentName}" (${selection.parent ? selection.parent.type : 'None'})`, 'info');
    if (parentFrame) {
      log(`Frame: "${frameName}"`, 'info');
    }
    
    // Verify it's an image node
    if (selection.type !== "RECTANGLE" || !selection.fills || selection.fills.length === 0) {
      updateStatus('error', 'Invalid selection');
      sendToUI('error', { message: 'Please select an image node (rectangle with image fill)' });
      log('Error: Invalid selection - not a rectangle with fills', 'error');
      return;
    }
    
    // Strictly use only visible IMAGE fills; ignore any hidden layers
    const allImageFills = selection.fills.filter(fill => fill.type === "IMAGE");
    log(`Found ${allImageFills.length} IMAGE fill(s)`, 'info');
    allImageFills.forEach((f, idx) => {
      const v = (typeof f.visible === 'boolean') ? f.visible : true;
      log(`IMAGE fill #${idx + 1}: visible=${v}, hasHash=${!!f.imageHash}`, 'info');
    });
    const visibleImageFills = allImageFills.filter(fill => fill.visible === true && !!fill.imageHash);
    log(`Visible IMAGE fills: ${visibleImageFills.length}`, 'info');
    // Choose the topmost visible IMAGE fill (last in array assumed topmost)
    const imageFill = visibleImageFills.length > 0 ? visibleImageFills[visibleImageFills.length - 1] : null;
    if (!imageFill) {
      updateStatus('error', 'No visible image found');
      sendToUI('error', { message: 'No visible IMAGE fill. Turn one on and try again.' });
      log('Error: No visible IMAGE fill found', 'error');
      return;
    }
    
    updateProgress(20);
    log(`Image hash: ${imageFill.imageHash}`, 'info');
    
    // Send node and frame information to UI
    sendToUI('updateNodeInfo', {
      nodeName: nodeName,
      parentName: parentName,
      parentType: selection.parent ? selection.parent.type : 'None',
      frameName: frameName,
      hasFrame: !!parentFrame
    });
    
    // Get the image
    const image = figma.getImageByHash(imageFill.imageHash);
    if (!image) {
      updateStatus('error', 'Could not load image');
      sendToUI('error', { message: 'Could not load image' });
      log('Error: Could not get image by hash', 'error');
      return;
    }
    
    updateStatus('info', 'Loading image...');
    updateProgress(30);
    log('Image loaded successfully', 'success');
    
    // Send input information to UI
    sendToUI('updateInput', {
      imageHash: imageFill.imageHash,
      imageSize: `${selection.width.toFixed(0)} × ${selection.height.toFixed(0)}`,
      dimensions: '-',
      bytes: 0,
      colorType: '-',
      bitDepth: '-',
      nodeName: nodeName,
      frameName: frameName
    });
    
    // Process the image
    await processImage(image, selection);
    
  } catch (error) {
    updateStatus('error', 'Error occurred');
    sendToUI('error', { message: error.message });
    log(`Error: ${error.message}`, 'error');
    console.error('Error:', error);
  }
}

// Get available color variables
async function getColorVariables() {
  try {
    const allVariables = figma.variables.getLocalVariables();
    const colorVariables = allVariables.filter(v => v.resolvedType === 'COLOR');
    return colorVariables.map(v => ({ id: v.id, name: v.name, resolvedType: v.resolvedType }));
  } catch (error) {
    log(`Error getting color variables: ${error.message}`, 'warning');
    return [];
  }
}

// Resolve a color variable to RGB
async function resolveColorVariable(variableId) {
  try {
    const variable = await figma.variables.getVariableByIdAsync(variableId);
    if (!variable || variable.resolvedType !== 'COLOR') return null;
    const valuesByMode = variable.valuesByMode;
    if (valuesByMode && Object.keys(valuesByMode).length > 0) {
      const modeId = Object.keys(valuesByMode)[0];
      const value = valuesByMode[modeId];
      if (value && typeof value === 'object' && value.r !== undefined && value.g !== undefined && value.b !== undefined) {
        return { r: value.r, g: value.g, b: value.b };
      }
      if (value && typeof value === 'object' && value.type === 'VARIABLE_ALIAS') {
        return await resolveColorVariable(value.id);
      }
    }
    return null;
  } catch (error) {
    log(`Error resolving color variable: ${error.message}`, 'warning');
    return null;
  }
}

async function processImage(image, node) {
  try {
    updateStatus('info', 'Getting image bytes...');
    updateProgress(40);
    log('Fetching image bytes...', 'info');
    
    // Get image bytes with timeout protection
    let bytes;
    try {
      const bytesPromise = image.getBytesAsync();
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Image bytes fetch timeout')), 3000)
      );
      bytes = await Promise.race([bytesPromise, timeoutPromise]);
      log(`Image bytes: ${bytes.length.toLocaleString()} bytes`, 'info');
      
      // Check if image is too large before processing (very large files can still cause issues)
      const MAX_IMAGE_SIZE = 50 * 1024 * 1024; // 50MB max - reasonable limit
      if (bytes.length > MAX_IMAGE_SIZE) {
        const errorMsg = `Image too large (${(bytes.length / 1024 / 1024).toFixed(1)}MB). Maximum allowed: 50MB. Try a smaller image.`;
        updateStatus('error', 'Image too large');
        sendToUI('error', { message: errorMsg });
        sendToUI('enableUndo', { enabled: false });
        log(`Error: ${errorMsg}`, 'error');
        return;
      }
      
      // Don't estimate complexity based on size - let edge detection determine actual complexity
    } catch (error) {
      const errorMsg = `Failed to get image bytes: ${error.message}`;
      updateStatus('error', 'Image fetch error');
      sendToUI('error', { message: errorMsg });
      sendToUI('enableUndo', { enabled: false });
      log(`Error: ${errorMsg}`, 'error');
      return;
    }
    
    updateProgress(50);
    updateStatus('info', 'Decoding PNG in UI...', 5); // 5 second timeout
    log('Sending image to UI for decoding and downscaling...', 'info');
    
    // Send image bytes to UI for decoding (UI has access to Image/Canvas APIs)
    // UI will also handle downscaling for better performance
    log(`Preparing to send ${bytes.length.toLocaleString()} bytes to UI...`, 'info');
    
    const pixelData = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pngDecodeResolve = null;
        pngDecodeReject = null;
        const errorMsg = 'PNG decoding timeout: Image too large or complex. Try a smaller image.';
        log(errorMsg, 'error');
        updateStatus('error', 'Decoding timeout');
        sendToUI('error', { message: errorMsg });
        sendToUI('enableUndo', { enabled: false });
        reject(new Error(errorMsg));
      }, 5000); // 5 second timeout - fail fast if image is too complex
      
      pngDecodeResolve = (data) => {
        clearTimeout(timeout);
        log('PNG decoded and downscaled successfully!', 'success');
        resolve(data);
      };
      pngDecodeReject = (error) => {
        clearTimeout(timeout);
        log(`PNG decode rejected: ${error.message}`, 'error');
        reject(error);
      };
      
      // Send bytes to UI for decoding and downscaling
      try {
        log('Sending bytes to UI...', 'info');
        const bytesArray = Array.from(bytes);
        log(`Converted ${bytes.length} bytes to array of length ${bytesArray.length}`, 'info');
        figma.ui.postMessage({
          type: 'decodePNG',
          bytes: bytesArray,
          maxDimension: maxDimension
        });
        log('Bytes sent to UI', 'info');
      } catch (error) {
        log(`Error sending bytes: ${error.message}`, 'error');
        reject(error);
      }
    });
    
    if (!pixelData || !pixelData.data) {
      updateStatus('error', 'Could not decode image');
      sendToUI('error', { message: 'Could not decode image' });
      log('Error: Failed to decode PNG', 'error');
      return;
    }
    
    const { data: pixelArray, width, height, originalWidth, originalHeight } = pixelData;
    
    // Convert array back to Uint8Array
    const data = new Uint8Array(pixelArray);
    
    // Width and height from UI are already downscaled if needed
    const scaledWidth = width;
    const scaledHeight = height;
    // Use original dimensions if provided, otherwise assume already downscaled
    const origWidth = originalWidth || width;
    const origHeight = originalHeight || height;
    
    log(`Decoded PNG: ${scaledWidth} × ${scaledHeight} pixels (from ${origWidth} × ${origHeight})`, 'success');
    
    // Update input information with decoded data
    const nodeName = node.name || 'Unnamed';
    const parentFrame = node.parent && node.parent.type === 'FRAME' ? node.parent : null;
    const frameName = parentFrame ? parentFrame.name : 'None';
    
    sendToUI('updateInput', {
      imageHash: '-',
      imageSize: `${node.width.toFixed(0)} × ${node.height.toFixed(0)}`,
      dimensions: `${origWidth} × ${origHeight} (downscaled to ${scaledWidth} × ${scaledHeight})`,
      bytes: bytes.length,
      colorType: 'RGBA', // From Canvas ImageData, always RGBA
      bitDepth: '8-bit', // From Canvas ImageData, always 8-bit per channel
      nodeName: nodeName,
      frameName: frameName
    });
    
    log(`Decoded and downscaled PNG: ${scaledWidth} × ${scaledHeight} pixels (RGBA, 8-bit)`, 'success');
    
    // Don't pre-check complexity - let edge detection determine actual complexity
    // Large images with simple shapes (like a big square) should still work
    
    updateProgress(65);
    updateStatus('info', 'Tracing edges...', 5); // 5 second timeout
    log('Starting edge detection...', 'info');
    
    // Trace the edges using downscaled pixel data (already downscaled by UI)
    // data is already downscaled if needed, and is a Uint8Array with RGBA format (4 bytes per pixel)
    const tracingResult = traceEdges(data, scaledWidth, scaledHeight, origWidth, origHeight);
    
    if (!tracingResult) {
      // traceEdges returned null due to complexity timeout
      return;
    }
    
    const { paths, edgePixels } = tracingResult;
    
    // Note: edge pixel count is already checked during scanning, so we shouldn't reach here
    // But keep this as a safety check
    const MAX_EDGE_PIXELS = 1000;
    if (edgePixels.length > MAX_EDGE_PIXELS) {
      const errorMsg = `Image too complex (${edgePixels.length.toLocaleString()} edge pixels found). Maximum allowed: ${MAX_EDGE_PIXELS.toLocaleString()}. Try a simpler image.`;
      updateStatus('error', 'Image too complex');
      sendToUI('error', { message: errorMsg });
      sendToUI('enableUndo', { enabled: false });
      log(`Error: ${errorMsg}`, 'error');
      return;
    }
    
    log(`Found ${edgePixels.length.toLocaleString()} edge pixels`, 'info');
    log(`Found ${paths.length} path(s)`, 'success');
    
    // Update processing information (will update simplified points after simplification)
    const totalPathPoints = paths.reduce((sum, path) => sum + path.length, 0);
    sendToUI('updateProcessing', {
      edgePixels: edgePixels.length,
      pathsFound: paths.length,
      pathPoints: totalPathPoints,
      simplifiedPoints: '-'
    });
    
    if (paths.length === 0) {
      updateStatus('warning', 'No edges found');
      sendToUI('error', { message: 'No edges found in the image' });
      log('Warning: No paths found', 'error');
      return;
    }
    
    updateProgress(80);
    updateStatus('info', 'Creating vector paths...', 3); // 3 second timeout
    log(`Creating ${paths.length} vector path(s)...`, 'info');
    
    // Create vector paths in Figma - pass original and scaled dimensions for proper scaling
    // paths are in scaled coordinates, so we need to pass both dimensions
    const createdPath = await createVectorPaths(paths, node, width, height, scaledWidth, scaledHeight, pathDensity);
    
    // Enable undo button if path was created
    if (createdPath) {
      sendToUI('enableUndo', { enabled: true });
    }
    
    updateProgress(100);
    updateStatus('success', 'Tracing complete!');
    sendToUI('complete', { message: `Created ${paths.length} path(s) from traced edges` });
    log(`Successfully created ${paths.length} vector path(s)`, 'success');
    
  } catch (error) {
    updateStatus('error', 'Processing error');
    sendToUI('error', { message: error.message });
    log(`Error: ${error.message}`, 'error');
    console.error('Error:', error);
  }
}

// Get color type name
function getColorTypeName(colorType) {
  const types = {
    0: 'Grayscale',
    2: 'RGB',
    3: 'Indexed',
    4: 'Grayscale + Alpha',
    6: 'RGB + Alpha'
  };
  return types[colorType] || `Unknown (${colorType})`;
}

// Decode PNG bytes to get pixel data
async function decodePNG(bytes, node) {
  try {
    log('Checking PNG signature...', 'info');
    
    // PNG signature check
    const pngSignature = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
    for (let i = 0; i < 8; i++) {
      if (bytes[i] !== pngSignature[i]) {
        throw new Error("Invalid PNG file");
      }
    }
    
    log('PNG signature valid', 'success');
    
    let offset = 8;
    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType = 0;
    let idatChunks = [];
    let chunkCount = 0;
    
    log('Parsing PNG chunks...', 'info');
    
    // Parse PNG chunks
    while (offset < bytes.length) {
      const chunkLength = readUint32(bytes, offset);
      offset += 4;
      const chunkType = readString(bytes, offset, 4);
      offset += 4;
      
      chunkCount++;
      log(`Found chunk: ${chunkType} (${chunkLength} bytes)`, 'info');
      
      if (chunkType === "IHDR") {
        width = readUint32(bytes, offset);
        height = readUint32(bytes, offset + 4);
        bitDepth = bytes[offset + 8];
        colorType = bytes[offset + 9];
        log(`IHDR: ${width} × ${height}, ${bitDepth}-bit, color type ${colorType}`, 'success');
        offset += chunkLength;
      } else if (chunkType === "IDAT") {
        // Collect IDAT chunks
        idatChunks.push({
          offset: offset,
          length: chunkLength,
          data: bytes.slice(offset, offset + chunkLength)
        });
        log(`IDAT chunk ${idatChunks.length}: ${chunkLength} bytes`, 'info');
        offset += chunkLength;
      } else {
        offset += chunkLength;
      }
      
      offset += 4; // Skip CRC
      
      if (chunkType === "IEND") {
        log(`Found IEND chunk, total chunks: ${chunkCount}`, 'success');
        break;
      }
    }
    
    if (width === 0 || height === 0) {
      throw new Error("Invalid image dimensions");
    }
    
    log(`Found ${idatChunks.length} IDAT chunk(s)`, 'info');
    
    // Combine IDAT chunks
    let totalIdatLength = 0;
    for (const chunk of idatChunks) {
      totalIdatLength += chunk.length;
    }
    
    log(`Total IDAT data: ${totalIdatLength.toLocaleString()} bytes`, 'info');
    
    const combinedIdat = new Uint8Array(totalIdatLength);
    let idatOffset = 0;
    for (const chunk of idatChunks) {
      combinedIdat.set(chunk.data, idatOffset);
      idatOffset += chunk.length;
    }
    
    // For this demo, we'll create pixel data based on image dimensions
    // In production, you'd decompress the IDAT chunks using a zlib inflate library
    // and process the actual PNG pixel data
    log('Processing pixel data (demo mode)...', 'warning');
    const pixelData = processPNGData(null, width, height, bitDepth, colorType);
    
    return { pixelData, width, height, bitDepth, colorType };
    
  } catch (error) {
    log(`PNG decode error: ${error.message}`, 'error');
    console.error("PNG decode error:", error);
    return null;
  }
}

// Helper functions for reading PNG data
function readUint32(bytes, offset) {
  return (bytes[offset] << 24) | (bytes[offset + 1] << 16) | 
         (bytes[offset + 2] << 8) | bytes[offset + 3];
}

function readString(bytes, offset, length) {
  let str = "";
  for (let i = 0; i < length; i++) {
    str += String.fromCharCode(bytes[offset + i]);
  }
  return str;
}

// Process PNG data after decompression
// NOTE: This is a simplified version for demonstration
// In production, you would:
// 1. Decompress the IDAT chunks using zlib inflate (use a library like pako)
// 2. Process the decompressed data to handle PNG filters
// 3. Convert to RGBA format based on colorType and bitDepth
function processPNGData(data, width, height, bitDepth, colorType) {
  log(`Creating pixel data array: ${width} × ${height} = ${(width * height).toLocaleString()} pixels`, 'info');
  
  const pixelData = new Uint8Array(width * height * 4);
  
  // For now, create a simple pattern to demonstrate edge detection
  // In production, this would properly process the decompressed PNG data
  // handling filters, color types, bit depths, etc.
  
  log('Generating demo pattern...', 'info');
  
  // Fill with a simple pattern for demonstration
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      
      // Create a simple pattern: non-transparent in center, transparent at edges
      const centerX = width / 2;
      const centerY = height / 2;
      const distX = Math.abs(x - centerX);
      const distY = Math.abs(y - centerY);
      const dist = Math.sqrt(distX * distX + distY * distY);
      const maxDist = Math.sqrt(centerX * centerX + centerY * centerY);
      
      if (dist < maxDist * 0.7) {
        pixelData[idx] = 255;     // R
        pixelData[idx + 1] = 255; // G
        pixelData[idx + 2] = 255; // B
        pixelData[idx + 3] = 255; // A (opaque)
      } else {
        pixelData[idx] = 0;       // R
        pixelData[idx + 1] = 0;   // G
        pixelData[idx + 2] = 0;   // B
        pixelData[idx + 3] = 0;   // A (transparent)
      }
    }
  }
  
  log('Pixel data generated', 'success');
  
  return pixelData;
}

// Downscale image to reduce number of edge pixels
// NOTE: This is now primarily done in the UI using Canvas API for better performance
// This function is kept as a fallback but should rarely be used
function downscaleImage(data, width, height, maxDimension) {
  // Calculate scale factor to keep largest dimension under maxDimension
  const scale = Math.min(1, maxDimension / Math.max(width, height));
  
  // If image is already small enough, return original
  if (scale >= 1) {
    return { data, width, height };
  }
  
  const newWidth = Math.max(1, Math.round(width * scale));
  const newHeight = Math.max(1, Math.round(height * scale));
  
  const downscaledData = new Uint8Array(newWidth * newHeight * 4);
  
  // Fast nearest-neighbor downscaling (much faster than box sampling)
  const scaleX = width / newWidth;
  const scaleY = height / newHeight;
  
  for (let y = 0; y < newHeight; y++) {
    for (let x = 0; x < newWidth; x++) {
      // Use nearest neighbor (fastest)
      const srcX = Math.floor(x * scaleX);
      const srcY = Math.floor(y * scaleY);
      const srcIdx = (srcY * width + srcX) * 4;
      const dstIdx = (y * newWidth + x) * 4;
      
      downscaledData[dstIdx] = data[srcIdx];
      downscaledData[dstIdx + 1] = data[srcIdx + 1];
      downscaledData[dstIdx + 2] = data[srcIdx + 2];
      downscaledData[dstIdx + 3] = data[srcIdx + 3];
    }
  }
  
  return { data: downscaledData, width: newWidth, height: newHeight };
}

// Trace edges using contour tracing algorithm
function traceEdges(data, width, height, originalWidth = width, originalHeight = height) {
  log(`Starting edge detection: ${width} × ${height} pixels`, 'info');
  
  const paths = [];
  const visited = new Set();
  
  // Find all edge pixels (non-transparent pixels with transparent neighbors)
  const edgePixels = [];
  
  // Complexity limits - based on actual edge pixel count, not assumptions
  const MAX_EDGE_PIXELS = 50000; // Stop at 50k edge pixels - fail fast to prevent freezing
  const MAX_PROCESSING_TIME_MS = 5000; // 5 seconds max - fail fast
  const startTime = Date.now();
  
  log('Scanning for edge pixels...', 'info');
  log(`Monitoring edge pixel count - will stop at ${MAX_EDGE_PIXELS.toLocaleString()} to prevent freezing`, 'info');
  
  // Find all edge pixels (non-transparent pixels with transparent neighbors)
  // Check edge pixel count frequently and stop immediately if too complex
  let pixelCount = 0;
  const totalPixels = width * height;
  const progressCheckInterval = Math.max(1000, Math.floor(totalPixels / 10)); // Check every 10% or 1000 pixels
  const edgePixelCheckInterval = 5000; // Check edge pixel count every 5k pixels scanned
  
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Check for timeout
      if (Date.now() - startTime > MAX_PROCESSING_TIME_MS) {
        const errorMsg = `Processing timeout after ${edgePixels.length.toLocaleString()} edge pixels. Image too complex. Try a simpler image.`;
        updateStatus('error', 'Processing timeout');
        sendToUI('error', { message: errorMsg });
        sendToUI('enableUndo', { enabled: false });
        log(`Error: ${errorMsg}`, 'error');
        return null;
      }
      
      // Check edge pixel count frequently - stop immediately if too complex
      if (edgePixels.length > MAX_EDGE_PIXELS) {
        const errorMsg = `Too many edge pixels detected (${edgePixels.length.toLocaleString()}). Stopping to prevent freeze. Maximum allowed: ${MAX_EDGE_PIXELS.toLocaleString()}. Try a simpler image.`;
        updateStatus('error', 'Image too complex');
        sendToUI('error', { message: errorMsg });
        sendToUI('enableUndo', { enabled: false });
        log(`Error: ${errorMsg}`, 'error');
        return null;
      }
      
      const idx = (y * width + x) * 4;
      const alpha = data[idx + 3];
      
      // Check if this is an edge pixel
      if (alpha > 0) {
        const isEdge = checkNeighbors(data, x, y, width, height);
        if (isEdge) {
          edgePixels.push({ x, y });
          
          // Check edge pixel count IMMEDIATELY after adding - fail fast
          if (edgePixels.length > MAX_EDGE_PIXELS) {
            const errorMsg = `Too many edge pixels detected (${edgePixels.length.toLocaleString()}). Stopping immediately to prevent freeze. Maximum allowed: ${MAX_EDGE_PIXELS.toLocaleString()}. Try a simpler image.`;
            updateStatus('error', 'Image too complex');
            sendToUI('error', { message: errorMsg });
            sendToUI('enableUndo', { enabled: false });
            log(`Error: ${errorMsg}`, 'error');
            return null;
          }
        }
      }
      
      // Progress check
      pixelCount++;
      if (pixelCount % progressCheckInterval === 0) {
        const progress = Math.floor((pixelCount / totalPixels) * 15) + 65; // 65-80% progress
        updateProgress(progress);
      }
      
      // Periodic check: if we're finding edge pixels too fast, warn
      if (pixelCount > 0 && pixelCount % edgePixelCheckInterval === 0) {
        const edgePixelRate = edgePixels.length / pixelCount;
        if (edgePixelRate > 0.3 && edgePixels.length > MAX_EDGE_PIXELS * 0.5) {
          // Finding edge pixels at >30% rate and already at 50% of limit - likely too complex
          log(`Warning: High edge pixel rate detected (${edgePixels.length.toLocaleString()} found so far)...`, 'warning');
        }
      }
    }
  }
  
  log(`Found ${edgePixels.length.toLocaleString()} edge pixels`, 'success');
  
  // Group edge pixels into connected paths
  log('Tracing contours...', 'info');
  
  // Create edgeSet ONCE - don't recreate it for each contour trace (major performance issue!)
  const edgeSet = new Set(edgePixels.map(p => `${p.x},${p.y}`));
  log(`Created edge set with ${edgeSet.size.toLocaleString()} pixels`, 'info');
  
  const contourStartTime = Date.now();
  const MAX_CONTOUR_TIME_MS = 3000; // 3 seconds max for contour tracing - fail fast
  const MAX_PATH_LENGTH = 10000; // Maximum path length to prevent infinite loops
  
  let pixelIndex = 0;
  for (const pixel of edgePixels) {
    // Check for timeout during contour tracing
    if (Date.now() - contourStartTime > MAX_CONTOUR_TIME_MS) {
      const errorMsg = `Contour tracing timeout after ${paths.length} paths. Image too complex. Try a simpler image.`;
      updateStatus('error', 'Processing timeout');
      sendToUI('error', { message: errorMsg });
      sendToUI('enableUndo', { enabled: false });
      log(`Error: ${errorMsg}`, 'error');
      return null;
    }
    
    // Check progress every 100 pixels
    pixelIndex++;
    if (pixelIndex % 100 === 0 && paths.length > 50) {
      // Already found 50+ paths and still processing - likely too complex
      const errorMsg = `Too many paths detected (${paths.length}). Image too complex. Try a simpler image.`;
      updateStatus('error', 'Image too complex');
      sendToUI('error', { message: errorMsg });
      sendToUI('enableUndo', { enabled: false });
      log(`Error: ${errorMsg}`, 'error');
      return null;
    }
    
    const key = `${pixel.x},${pixel.y}`;
    if (!visited.has(key)) {
      const path = traceContour(pixel, edgeSet, visited, width, height, MAX_PATH_LENGTH, contourStartTime, MAX_CONTOUR_TIME_MS);
      if (!path) {
        // traceContour returned null due to timeout or complexity
        return null;
      }
      if (path.length > 2) {
        paths.push(path);
        if (paths.length <= 5) { // Only log first 5 to avoid spam
          log(`Traced contour ${paths.length}: ${path.length} points`, 'info');
        }
      }
      
      // If we have too many paths, it's getting complex
      if (paths.length > 50) {
        const errorMsg = `Too many paths detected (${paths.length}). Image too complex. Try a simpler image.`;
        updateStatus('error', 'Image too complex');
        sendToUI('error', { message: errorMsg });
        sendToUI('enableUndo', { enabled: false });
        log(`Error: ${errorMsg}`, 'error');
        return null;
      }
    }
  }
  
  return { paths, edgePixels };
}

// Check if a pixel has transparent neighbors
function checkNeighbors(data, x, y, width, height) {
  const directions = [
    [-1, -1], [0, -1], [1, -1],
    [-1, 0],           [1, 0],
    [-1, 1],  [0, 1],  [1, 1]
  ];
  
  for (const [dx, dy] of directions) {
    const nx = x + dx;
    const ny = y + dy;
    
    if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
      return true; // Edge of image
    }
    
    const idx = (ny * width + nx) * 4;
    const alpha = data[idx + 3];
    if (alpha === 0) {
      return true; // Has transparent neighbor
    }
  }
  
  return false;
}

// Trace a contour starting from a given pixel using Moore neighborhood
function traceContour(startPixel, edgeSet, visited, width, height, maxPathLength, startTime, maxTime) {
  const path = [];
  const pathSet = new Set(); // Track visited pixels in this path to detect loops
  
  let current = startPixel;
  let direction = 0; // 0 = right, 1 = down-right, etc.
  let iterations = 0;
  const MAX_ITERATIONS = maxPathLength || 10000; // Maximum iterations per contour
  
  // Moore neighborhood directions (clockwise starting from right)
  const mooreNeighbors = [
    [1, 0],   [1, 1],   [0, 1],   [-1, 1],
    [-1, 0],  [-1, -1], [0, -1],  [1, -1]
  ];
  
  do {
    // Check timeout
    if (startTime && maxTime && Date.now() - startTime > maxTime) {
      return null; // Timeout
    }
    
    // Check iterations to prevent infinite loops
    iterations++;
    if (iterations > MAX_ITERATIONS) {
      log(`Warning: Contour exceeded max iterations (${MAX_ITERATIONS}). Stopping.`, 'warning');
      break;
    }
    
    // Check path length
    if (path.length > MAX_ITERATIONS) {
      log(`Warning: Path too long (${path.length}). Stopping.`, 'warning');
      break;
    }
    
    // Detect cycles in path (same pixel visited twice means we're looping)
    const key = `${current.x},${current.y}`;
    if (pathSet.has(key) && path.length > 4) {
      // We've visited this pixel before - likely a cycle, break out
      break;
    }
    pathSet.add(key);
    
    if (!visited.has(key)) {
      visited.add(key);
      path.push({ x: current.x, y: current.y });
    }
    
    // Try to find next pixel in Moore neighborhood
    let found = false;
    for (let i = 0; i < 8; i++) {
      const checkDir = (direction + i) % 8;
      const [dx, dy] = mooreNeighbors[checkDir];
      const nextX = current.x + dx;
      const nextY = current.y + dy;
      
      if (nextX >= 0 && nextX < width && nextY >= 0 && nextY < height) {
        const nextKey = `${nextX},${nextY}`;
        if (edgeSet.has(nextKey)) {
          current = { x: nextX, y: nextY };
          direction = (checkDir + 6) % 8; // Adjust direction for next iteration
          found = true;
          break;
        }
      }
    }
    
    if (!found) {
      break;
    }
    
  } while (!(current.x === startPixel.x && current.y === startPixel.y && path.length >= 4));
  
  return path;
}

// Calculate the angle at a point in the path (for detecting sharp corners)
function calculateAngle(prev, current, next) {
  const dx1 = current.x - prev.x;
  const dy1 = current.y - prev.y;
  const dx2 = next.x - current.x;
  const dy2 = next.y - current.y;
  
  const angle1 = Math.atan2(dy1, dx1);
  const angle2 = Math.atan2(dy2, dx2);
  
  let angle = angle2 - angle1;
  if (angle > Math.PI) angle -= 2 * Math.PI;
  if (angle < -Math.PI) angle += 2 * Math.PI;
  
  return Math.abs(angle);
}

// Simplify path to target number of points, but keep more points near sharp corners
function simplifyPath(path, targetPoints) {
  if (path.length <= targetPoints) return path;
  
  // Ensure we have at least 3 points (minimum for a closed path)
  targetPoints = Math.max(3, Math.min(targetPoints, path.length));
  
  // First, identify sharp corners (angles close to 90 degrees or more)
  const cornerIndices = new Set();
  for (let i = 1; i < path.length - 1; i++) {
    const angle = calculateAngle(path[i - 1], path[i], path[i + 1]);
    // If angle is sharp (less than ~135 degrees), mark as corner
    if (angle > Math.PI * 0.25) { // 45 degrees in radians
      cornerIndices.add(i);
    }
  }
  
  // Calculate step size to sample evenly
  const step = (path.length - 1) / (targetPoints - 1);
  
  const simplified = [];
  const includedIndices = new Set();
  
  // Always include first point
  simplified.push(path[0]);
  includedIndices.add(0);
  
  // Include corner points
  for (const cornerIdx of cornerIndices) {
    if (!includedIndices.has(cornerIdx)) {
      simplified.push(path[cornerIdx]);
      includedIndices.add(cornerIdx);
    }
  }
  
  // Sample remaining points at regular intervals
  for (let i = 1; i < targetPoints - 1; i++) {
    const index = Math.round(i * step);
    if (!includedIndices.has(index)) {
      simplified.push(path[index]);
      includedIndices.add(index);
    }
  }
  
  // Sort by original index to maintain path order
  simplified.sort((a, b) => {
    const idxA = path.indexOf(a);
    const idxB = path.indexOf(b);
    return idxA - idxB;
  });
  
  return simplified;
}

// Undo last tracing operation
async function undoLastTracing() {
  if (lastCreatedVectorPath && !lastCreatedVectorPath.removed) {
    try {
      lastCreatedVectorPath.remove();
      lastCreatedVectorPath = null;
      sendToUI('enableUndo', { enabled: false });
      log('Undo: Removed last traced outline', 'success');
      // Show success message briefly, then reset to Ready after a short delay
      updateStatus('success', 'Undo: Removed traced outline');
      setTimeout(() => {
        updateStatus('info', 'Ready');
      }, 1500); // Reset to Ready after 1.5 seconds
    } catch (error) {
      log(`Error undoing: ${error.message}`, 'error');
      updateStatus('error', 'Could not undo');
    }
  } else {
    log('Nothing to undo', 'warning');
    updateStatus('warning', 'Nothing to undo');
  }
}

// Create vector paths in Figma - combine into single outline
async function createVectorPaths(paths, node, originalWidth, originalHeight, scaledWidth, scaledHeight, targetPoints = 10) {
  const parent = node.parent;
  
  if (paths.length === 0) return null;
  
  // Find the largest path (main outline)
  let mainPath = paths.reduce((largest, path) => 
    path.length > largest.length ? path : largest, paths[0]);
  
  if (mainPath.length < 3) return;
  
  // Simplify the path to target number of points
  log(`Simplifying path from ${mainPath.length} points to target ${targetPoints} points...`, 'info');
  mainPath = simplifyPath(mainPath, targetPoints);
  log(`Simplified to ${mainPath.length} points`, 'success');
  
  // Update UI with simplified point count
  sendToUI('updateProcessing', {
    simplifiedPoints: mainPath.length
  });
  
  // Calculate scale from scaled coordinates back to original image coordinates
  // Note: paths are in scaled coordinates, so we need to scale them back up
  const scaleX = originalWidth / scaledWidth;
  const scaleY = originalHeight / scaledHeight;
  
  // Scale path points back to original image coordinates
  mainPath = mainPath.map(p => ({
    x: p.x * scaleX,
    y: p.y * scaleY
  }));
  
  // Calculate bounds with scaled-up coordinates
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  mainPath.forEach(p => {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  });
  
  const pathWidth = maxX - minX || 1;
  const pathHeight = maxY - minY || 1;
  
  // Calculate scale from original image pixel coordinates to node display size
  const pixelToNodeScaleX = node.width / originalWidth;
  const pixelToNodeScaleY = node.height / originalHeight;
  
  // Calculate the actual size of the traced shape in node coordinates
  const tracedShapeWidth = pathWidth * pixelToNodeScaleX;
  const tracedShapeHeight = pathHeight * pixelToNodeScaleY;
  
  // Calculate offset from image origin to traced shape origin (in node coordinates)
  const offsetX = minX * pixelToNodeScaleX;
  const offsetY = minY * pixelToNodeScaleY;
  
  // Create single vector path
  const vectorPath = figma.createVector();
  vectorPath.name = `Traced Outline`;
  
  // Build path data - offset points outward slightly to prevent cutting into corners
  let pathData = '';
  
  // Convert path points to node coordinates and offset outward
  const scaledPath = mainPath.map((p, index) => {
    const x = (p.x - minX) * pixelToNodeScaleX;
    const y = (p.y - minY) * pixelToNodeScaleY;
    
    // Calculate outward offset for this point
    // Get previous and next points to calculate normal
    const prev = mainPath[(index - 1 + mainPath.length) % mainPath.length];
    const next = mainPath[(index + 1) % mainPath.length];
    
    // Calculate direction vectors
    const dx1 = p.x - prev.x;
    const dy1 = p.y - prev.y;
    const dx2 = next.x - p.x;
    const dy2 = next.y - p.y;
    
    // Average direction
    const avgDx = (dx1 + dx2) / 2;
    const avgDy = (dy1 + dy2) / 2;
    
    // Calculate perpendicular (outward) vector
    const perpDx = -avgDy;
    const perpDy = avgDx;
    const perpLength = Math.sqrt(perpDx * perpDx + perpDy * perpDy);
    
    // Normalize and offset outward by a small amount (0.5 pixels scaled)
    const offsetAmount = 0.5 * Math.min(pixelToNodeScaleX, pixelToNodeScaleY);
    const offsetX = perpLength > 0 ? (perpDx / perpLength) * offsetAmount : 0;
    const offsetY = perpLength > 0 ? (perpDy / perpLength) * offsetAmount : 0;
    
    return {
      x: x + offsetX,
      y: y + offsetY
    };
  });
  
  // Build path data - simple straight lines (corner radius applied via property)
  pathData = `M ${scaledPath[0].x} ${scaledPath[0].y}`;
  
  // Use lines to connect points
  for (let i = 1; i < scaledPath.length; i++) {
    pathData += ` L ${scaledPath[i].x} ${scaledPath[i].y}`;
  }
  
  // Close the path
  pathData += ` Z`;
  
  // Set the path
  vectorPath.vectorPaths = [{
    windingRule: "EVENODD",
    data: pathData
  }];
  
  // Apply custom stroke/fill based on styleSettings
  let strokeColorToUse = styleSettings.strokeColor;
  if (styleSettings.strokeColorVariableId) {
    const resolved = await resolveColorVariable(styleSettings.strokeColorVariableId);
    if (resolved) strokeColorToUse = resolved;
  }
  vectorPath.strokes = [{ type: "SOLID", color: strokeColorToUse }];
  vectorPath.strokeWeight = styleSettings.strokeThickness || 2;
  vectorPath.strokeAlign = "CENTER";

  // Fill
  let fills = [];
  if (styleSettings.fillColor !== null || styleSettings.fillColorVariableId) {
    let fillColorToUse = styleSettings.fillColor;
    if (styleSettings.fillColorVariableId) {
      const resolvedFill = await resolveColorVariable(styleSettings.fillColorVariableId);
      if (resolvedFill) fillColorToUse = resolvedFill;
    }
    if (fillColorToUse) fills = [{ type: "SOLID", color: fillColorToUse }];
  }
  vectorPath.fills = fills;

  // Drop shadow
  if (styleSettings.dropShadow && styleSettings.dropShadow.enabled) {
    let shadowColor = styleSettings.dropShadow.color || { r: 0, g: 0, b: 0, a: 1 };
    if (styleSettings.dropShadow.colorVariableId) {
      const resolvedShadow = await resolveColorVariable(styleSettings.dropShadow.colorVariableId);
      if (resolvedShadow) {
        shadowColor = { r: resolvedShadow.r, g: resolvedShadow.g, b: resolvedShadow.b, a: styleSettings.dropShadow.opacity || 1 };
      }
    }
    if (shadowColor.a === undefined) shadowColor.a = styleSettings.dropShadow.opacity || 1;
    vectorPath.effects = [{
      type: "DROP_SHADOW",
      visible: true,
      color: shadowColor,
      blendMode: "NORMAL",
      offset: { x: styleSettings.dropShadow.x || 0, y: styleSettings.dropShadow.y || 0 },
      radius: styleSettings.dropShadow.blur || 0,
      spread: 0
    }];
  }
  
  // Position at the correct location: node position + offset to traced shape
  vectorPath.x = node.x + offsetX;
  vectorPath.y = node.y + offsetY;
  
  // Size to match the actual traced shape size, not the full image
  vectorPath.resize(tracedShapeWidth, tracedShapeHeight);
  
  // Apply corner radius if specified
  const cornerRadius = styleSettings.cornerRadius || 0;
  if (cornerRadius > 0) {
    vectorPath.cornerRadius = cornerRadius;
  }
  
  // Add to parent
  parent.appendChild(vectorPath);
  
  // Store reference for undo functionality
  lastCreatedVectorPath = vectorPath;
  
  // Return the created path for reference
  return vectorPath;
}
