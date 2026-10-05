import * as THREE from './vendor/three.module.min.js';
window.THREE = THREE;
window.dispatchEvent(new Event('three-ready'));
