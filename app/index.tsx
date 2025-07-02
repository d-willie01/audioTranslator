import { Audio } from 'expo-av';
import React, { useEffect, useRef, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

// Updated WebSocket URL to match your Docker container configuration

//LOCAL
//const WS_URL = 'ws://192.168.0.222:5001/ws/transcribe';

// Updated WebSocket URL to use Render's hosted container

//PUBLIC
const WS_URL = 'wss://audioapi-75p7.onrender.com/ws/transcribe';





// Audio worklet processor code
const workletCode = `
class AudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bufferSize = 16000; // 1 second of audio at 16kHz
    this.buffer = new Float32Array(this.bufferSize);
    this.bufferIndex = 0;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const channel = input[0];

    if (!channel) return true;

    // Fill our buffer
    for (let i = 0; i < channel.length; i++) {
      this.buffer[this.bufferIndex++] = channel[i];

      // When buffer is full, send it
      if (this.bufferIndex >= this.bufferSize) {
        this.port.postMessage(this.buffer.slice());
        this.bufferIndex = 0;
      }
    }

    return true;
  }
}

registerProcessor('audio-processor', AudioProcessor);
`;

export default function App() {
  const [isRecording, setIsRecording] = useState(false);
  const [transcription, setTranscription] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const recording = useRef(null);
  const ws = useRef(null);
  const reconnectTimeout = useRef(null);
  const isRecordingRef = useRef(false);
  const audioContext = useRef(null);
  const sourceNode = useRef(null);
  const workletNode = useRef(null);
  const destinationNode = useRef(null);

  const connectWebSocket = () => {
    try {
      console.log('Attempting to connect to:', WS_URL);
      ws.current = new WebSocket(WS_URL);
      
      ws.current.onopen = () => {
        console.log('WebSocket Connected successfully');
        setIsConnected(true);
        if (reconnectTimeout.current) {
          clearTimeout(reconnectTimeout.current);
          reconnectTimeout.current = null;
        }
      };

      ws.current.onmessage = (event) => {
        console.log('Received transcription:', event.data);
        setTranscription(prev => prev + ' ' + event.data);
      };

      ws.current.onerror = (error) => {
        console.error('WebSocket error:', error);
        setIsConnected(false);
      };

      ws.current.onclose = (event) => {
        console.log('WebSocket disconnected:', event.code, event.reason);
        setIsConnected(false);
        // Attempt to reconnect after 3 seconds
        reconnectTimeout.current = setTimeout(connectWebSocket, 3000);
      };
    } catch (error) {
      console.error('Error creating WebSocket:', error);
      setIsConnected(false);
    }
  };

  useEffect(() => {
    connectWebSocket();

    return () => {
      if (ws.current) {
        ws.current.close();
      }
      if (reconnectTimeout.current) {
        clearTimeout(reconnectTimeout.current);
      }
      if (audioContext.current) {
        audioContext.current.close();
      }
    };
  }, []);

  const setupAudioWorklet = async (stream) => {
    try {
      // Create audio context
      audioContext.current = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: 16000,
      });

      // Load and register the worklet
      const blob = new Blob([workletCode], { type: 'application/javascript' });
      const workletUrl = URL.createObjectURL(blob);
      await audioContext.current.audioWorklet.addModule(workletUrl);

      // Create nodes
      sourceNode.current = audioContext.current.createMediaStreamSource(stream);
      workletNode.current = new AudioWorkletNode(audioContext.current, 'audio-processor');
      destinationNode.current = audioContext.current.createMediaStreamDestination();

      // Connect nodes
      sourceNode.current.connect(workletNode.current);
      workletNode.current.connect(destinationNode.current);

      // Handle audio data from worklet
      workletNode.current.port.onmessage = async (event) => {
        if (!isRecordingRef.current || !ws.current || ws.current.readyState !== WebSocket.OPEN) return;

        const audioData = event.data;
        // Convert Float32Array to WAV format
        const wavBuffer = convertToWav(audioData);
        
        // Send the WAV data
        ws.current.send(wavBuffer);
      };

      console.log('Audio worklet setup complete');
    } catch (error) {
      console.error('Error setting up audio worklet:', error);
      throw error;
    }
  };

  const convertToWav = (audioData) => {
    const numChannels = 1;
    const sampleRate = 16000;
    const bitsPerSample = 16;
    const bytesPerSample = bitsPerSample / 8;
    const blockAlign = numChannels * bytesPerSample;
    const byteRate = sampleRate * blockAlign;
    const dataSize = audioData.length * bytesPerSample;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    // Write WAV header
    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeString(view, 8, 'WAVE');
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitsPerSample, true);
    writeString(view, 36, 'data');
    view.setUint32(40, dataSize, true);

    // Write audio data
    const offset = 44;
    for (let i = 0; i < audioData.length; i++) {
      const sample = Math.max(-1, Math.min(1, audioData[i]));
      view.setInt16(offset + i * bytesPerSample, sample * 0x7FFF, true);
    }

    return buffer;
  };

  const writeString = (view, offset, string) => {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  };

  async function startRecording() {
    if (!isConnected) {
      Alert.alert('Error', 'Not connected to server');
      return;
    }

    try {
      const { status } = await Audio.requestPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Error', 'Permission to access microphone was denied');
        return;
      }

      // Get audio stream
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 16000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        }
      });

      // Setup audio worklet
      await setupAudioWorklet(stream);
      
      isRecordingRef.current = true;
      setIsRecording(true);
      console.log('Recording started successfully');
    } catch (err) {
      console.error('Failed to start recording:', err);
      Alert.alert('Error', 'Failed to start recording');
    }
  }

  async function stopRecording() {
    if (!isRecordingRef.current) return;

    try {
      console.log('Stopping recording...');
      isRecordingRef.current = false;

      // Clean up audio nodes
      if (sourceNode.current) {
        sourceNode.current.disconnect();
        sourceNode.current = null;
      }
      if (workletNode.current) {
        workletNode.current.disconnect();
        workletNode.current = null;
      }
      if (destinationNode.current) {
        destinationNode.current.disconnect();
        destinationNode.current = null;
      }
      if (audioContext.current) {
        await audioContext.current.close();
        audioContext.current = null;
      }

      setIsRecording(false);
      console.log('Recording stopped');
    } catch (err) {
      console.error('Failed to stop recording:', err);
      Alert.alert('Error', 'Failed to stop recording');
    }
  }

  return (
    <View style={styles.container}>
      <View style={styles.statusContainer}>
        <Text style={[styles.statusText, { color: isConnected ? 'green' : 'red' }]}>
          {isConnected ? 'Connected' : 'Disconnected'}
        </Text>
      </View>

      <ScrollView style={styles.transcriptionContainer}>
        <Text style={styles.transcriptionText}>{transcription}</Text>
      </ScrollView>
      
      <TouchableOpacity
        style={[styles.button, isRecording && styles.recordingButton]}
        onPress={isRecording ? stopRecording : startRecording}
        disabled={!isConnected}
      >
        <Text style={styles.buttonText}>
          {isRecording ? 'Stop Recording' : 'Start Recording'}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
    padding: 20,
  },
  statusContainer: {
    padding: 10,
    alignItems: 'center',
  },
  statusText: {
    fontSize: 16,
    fontWeight: 'bold',
  },
  transcriptionContainer: {
    flex: 1,
    marginVertical: 20,
    padding: 10,
    backgroundColor: '#f5f5f5',
    borderRadius: 10,
  },
  transcriptionText: {
    fontSize: 16,
    lineHeight: 24,
  },
  button: {
    backgroundColor: '#007AFF',
    padding: 15,
    borderRadius: 10,
    alignItems: 'center',
  },
  recordingButton: {
    backgroundColor: '#FF3B30',
  },
  buttonText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: 'bold',
  },
});