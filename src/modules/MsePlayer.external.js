import * as segmentsTypes from '../enums/segments'

import {AUDIO, VIDEO} from '../enums/common'

import EVENTS from '../enums/events'
import MSG from '../enums/messages'
import * as mseUtils from '../utils/mseUtils'
import {logger} from '../utils/logger'

import 'core-js/fn/array/find'

const TYPE_CONTENT_VIDEO = VIDEO
const TYPE_CONTENT_AUDIO = AUDIO

const BUFFER_MODE_SEGMENTS = 'segments'
const BUFFER_MODE_SEQUENCE = 'sequence'

const LIVE = 'live'
const WS_COMMAND_SEEK_LIVE = ''
const WS_COMMAND_SEEK = 'play_from='
const DEFAULT_BUFFER_MODE = BUFFER_MODE_SEQUENCE
const DEFAULT_ERRORS_BEFORE_STOP = 1
const DEFAULT_UPDATE = 100

let errorsCount = 0

export default class MSEPlayer {
  static replaceHttpByWS(url) {
    return mseUtils.replaceHttpByWS(url)
  }

  static isSupported() {
    return mseUtils.isSupportedMSE()
  }
  /**
   *
   * @param media HTMLMediaElement
   * @param urlStream
   *
   */
  constructor(media, urlStream, opts) {
    if (!(media instanceof HTMLMediaElement)) {
      throw new Error(MSG.NOT_HTML_MEDIA_ELEMENT)
    }

    this.media = media
    this.url = urlStream
    this.opts = opts || {}
    this.opts.progressUpdateTime = this.opts.progressUpdateTime || DEFAULT_UPDATE
    this.setBufferMode(this.opts)

    this.opts.errorsBeforeStop = this.opts.errorsBeforeStop ? this.opts.errorsBeforeStop : DEFAULT_ERRORS_BEFORE_STOP

    if (typeof this.opts.errorsBeforeStop !== 'number' || isNaN(this.opts.errorsBeforeStop)) {
      throw new Error('invalid errorsBeforeStop param, should be number')
    }

    this.onProgress = opts && opts.onProgress
    this.onMediaInfo = opts && opts.onMediaInfo
    this.onError = opts && opts.onError

    this.doArrayBuffer = mseUtils.doArrayBuffer.bind(this)
    this.maybeAppend = this.maybeAppend.bind(this)

    // Source Buffer listeners
    this.onsbue = this.onSBUpdateEnd.bind(this);

    this.init()

    this.onAttachMedia({media})
  }

  play(time, videoTrack, audioTack) {
    if (this.opts.debug) {
      console.log('FlussonicMsePlayer: play()')
    }
    return this._play(time, videoTrack, audioTack)
  }

  stop() {
    return this.onMediaDetaching()
  }

  seek(utc) {
    try {
      if (!utc) {
        throw new Error('utc should be "live" or UTC value')
      }
      const commandStr = utc === LIVE
        ? WS_COMMAND_SEEK_LIVE
        : WS_COMMAND_SEEK
      console.log(`${commandStr}${utc}`)
      this.websocket.send(`${commandStr}${utc}`)
      this.afterSeekFlag = true
    } catch (err) {
      console.warn(`onMediaDetaching:${err.message} while calling endOfStream`)
    }
  }

  pause() {
    if (
      this._pause ||
      !this.media ||
      !this.websocket ||
      !this.mediaSource ||
      (this.mediaSource && this.mediaSource.readyState !== 'open') ||
      !this.playPromise
    ) {
      return
    }

    // https://developers.google.com/web/updates/2017/06/play-request-was-interrupted
    this.playPromise.then(pause.bind(this))
    function pause() {
      this.media.pause()
      this.websocket.send('pause')
      this._pause = true
      this.playing = false

      if (this.onPause) {
        try {
          this.onPause()
        } catch (e) {
          console.error('Error ' + e.name + ':' + e.message + '\n' + e.stack)
        }
      }
    }
  }

  setTracks(tracks) {
    if (!this.mediaInfo) {
      console.warn('Media info did not loaded. Should try after onMediaInfo triggered or inside.')
      return
    }

    if (!Array.isArray(tracks)) {
      console.error('tracks should be an Array instance: ["v1", "a1"]')
    }

    const videoTracksStr = tracks
      .filter(id => {
        const stream = this.mediaInfo.streams.find(s => id === s['track_id'])
        return !!stream && stream.content === TYPE_CONTENT_VIDEO
      })
      .join('')

    const audioTracksStr = tracks
      .filter(id => {
        const stream = this.mediaInfo.streams.find(s => id === s['track_id'])
        return !!stream && stream.content === TYPE_CONTENT_AUDIO
      })
      .join('')

    return this._setTracks(videoTracksStr, audioTracksStr)
  }

  /**
   *
   *  Private members
   *
   */
  _log(msg) {
    if (this.opts.debug) {
      console.log(msg)
    }
  }

  _play(time, videoTrack, audioTack) {
    return new Promise((resolve, reject) => {
      if (this.playing) {
        this._log('_play: terminate because already has been playing')
        return resolve()
      }

      if (this._pause && !this.afterSeekFlag) {
        this._resume()
        this._log('_play: terminate because _paused and should resume')
        return resolve()
      }

      // TODO: to observe this case, I have no idea when it fired
      if (!this.mediaSource) {
        this.onAttachMedia({media: this.media})
        this.onsoa = this._play.bind(this, time, videoTrack, audioTack)
        this.mediaSource.addEventListener(EVENTS.MEDIA_SOURCE_SOURCE_OPEN, this.onsoa)
        console.warn('mediaSource did not create')
        this.resolveThenMediaSourceOpen = this.resolveThenMediaSourceOpen
          ? this.resolveThenMediaSourceOpen
          : resolve
        this.rejectThenMediaSourceOpen = this.rejectThenMediaSourceOpen
            ? this.rejectThenMediaSourceOpen
            : reject
        return
      }

      this.playTime = time
      this.videoTrack = videoTrack
      this.audioTack = audioTack

      // deferring execution
      if (this.mediaSource && this.mediaSource.readyState !== 'open') {
        console.warn('readyState is not "open"')
        this.shouldPlay = true
        this.resolveThenMediaSourceOpen = this.resolveThenMediaSourceOpen
          ? this.resolveThenMediaSourceOpen
          : resolve
        this.rejectThenMediaSourceOpen = this.rejectThenMediaSourceOpen
          ? this.rejectThenMediaSourceOpen
          : reject
        return
      }

      this._pause = false
      this.playing = true

      const startWS = mseUtils.startWebSocket(this.url, time, videoTrack, audioTack)

      startWS.bind(this)()

      // https://developers.google.com/web/updates/2017/06/play-request-was-interrupted
      this.playPromise = this.media.play()
      this.startProgressTimer()
      this.playing = true

      this.playPromise.then(() => {
        if (this.resolveThenMediaSourceOpen) {
          this.resolveThenMediaSourceOpen()
          this.resolveThenMediaSourceOpen = void 0
          this.rejectThenMediaSourceOpen = void 0
        }
      }, () => {
        if (this.rejectThenMediaSourceOpen) {
          this.rejectThenMediaSourceOpen()
          this.resolveThenMediaSourceOpen = void 0
          this.rejectThenMediaSourceOpen = void 0
        }
      })
      return this.playPromise
    })
  }

  init() {
    // start new implementation
    this.sourceBuffer = {}
    this.flushRange = [];
    this.appended = 0;
    this._missed = 0;
    // end new inplementation

    this._buffers = {}
    this._queues = {}
    this.playing = false

    // flag to pending execution(true)
    this.shouldPlay = false

    // store to execute pended method play
    this.playTime = void 0
    this.audioTack = ''
    this.videoTrack = ''
    this.endProgressTimer()
  }

  _resume() {
    this.websocket.send('resume')
    this.playPromise = this.media.play()
    this._pause = false
    this.playing = true
  }

  onMediaDetaching() {
    if (this.stopRunning) {
      console.log('stop is running.')
      return
    }
    this.stopRunning = true
    // https://developers.google.com/web/updates/2017/06/play-request-was-interrupted
    const bindedMD = this.handlerMediaDetaching.bind(this)
    if (this.playPromise) {
      // there are two cases:
      // resolved/rejected
      // both required to shutdown ws, mediasources and etc.
      return this.playPromise.then(bindedMD, bindedMD)
    }
    if (!this.playPromise) {
      return this.handlerMediaDetaching()
    }
  }

  handlerMediaDetaching() {
    console.info('media source detaching')

    let mediaEmptyPromise

    // destroy media source and detach from media element
    this.removeMediaSource()

    if (this.media) {
      this.media.removeEventListener(EVENTS.MEDIA_ELEMENT_PROGRESS, this.oncvp) // checkVideoProgress
      mediaEmptyPromise = new Promise(resolve => {
        this._onmee = this.onMediaElementEmptied(resolve).bind(this)
      })
      mediaEmptyPromise.then(() => this.stopRunning = false)
      this.media.addEventListener(EVENTS.MEDIA_ELEMENT_EMPTIED, this._onmee)
    }

    this.oncvp = null

    this.mediaSource = null

    this.init()
    this.destroyWebsocket()

    return mediaEmptyPromise
  }

  removeMediaSource() {
    const ms = this.mediaSource
    if (ms) {
      if (ms.readyState === 'open') {
        try {
          // endOfStream could trigger exception if any sourcebuffer is in updating state
          // we don't really care about checking sourcebuffer state here,
          // as we are anyway detaching the MediaSource
          // let's just avoid this exception to propagate
          ms.endOfStream()
        } catch (err) {
          console.warn(`onMediaDetaching:${err.message} while calling endOfStream`)
        }
      }

      ms.removeEventListener(EVENTS.MEDIA_SOURCE_SOURCE_OPEN, this.onmso)
      ms.removeEventListener(EVENTS.MEDIA_SOURCE_SOURCE_ENDED, this.onmse)
      ms.removeEventListener(EVENTS.MEDIA_SOURCE_SOURCE_CLOSE, this.onmsc)
      this.onmso = null
      this.onmse = null
      this.onmsc = null
    }

    // Detach properly the MediaSource from the HTMLMediaElement as
    // suggested in https://github.com/w3c/media-source/issues/53.
    URL.revokeObjectURL(this.media.src)
    this.media.removeAttribute('src')
    this.media.load()
  }

  onMediaElementEmptied(resolve) {
    if (this._onmee && this.media) {
      this.media.removeEventListener(EVENTS.MEDIA_ELEMENT_EMPTIED, this._onmee)
      this._onmee = void 0
    }
    return resolve()
  }

  onAttachMedia(data) {
    this.media = data.media
    const media = this.media
    if (media) {
      // setup the media source
      const ms = (this.mediaSource = new MediaSource())
      //Media Source listeners

      this.onmse = this.onMediaSourceEnded.bind(this)
      this.onmsc = this.onMediaSourceClose.bind(this)

      ms.addEventListener(EVENTS.MEDIA_SOURCE_SOURCE_ENDED, this.onmse)
      ms.addEventListener(EVENTS.MEDIA_SOURCE_SOURCE_CLOSE, this.onmsc)
      // link video and media Source
      media.src = URL.createObjectURL(ms)

      this.oncvp = mseUtils.checkVideoProgress(media).bind(this)
      this.media.addEventListener(EVENTS.MEDIA_ELEMENT_PROGRESS, this.oncvp)
      return new Promise(resolve => {
        this.onmso = this.onMediaSourceOpen.bind(this, resolve)
        ms.addEventListener(EVENTS.MEDIA_SOURCE_SOURCE_OPEN, this.onmso)
      })
    }
  }

  onMediaSourceOpen(resolve) {
    resolve()
    let mediaSource = this.mediaSource
    if (mediaSource) {
      // once received, don't listen anymore to sourceopen event
      mediaSource.removeEventListener(EVENTS.MEDIA_SOURCE_SOURCE_OPEN, this.onmso)
    }

    // play was called but stoped and was pend(1.readyState is not open)
    // and time is come to execute it
    if (this.shouldPlay) {
      console.info(
        `readyState now is ${this.mediaSource.readyState}, and will be played`,
        this.playTime,
        this.audioTack,
        this.videoTrack
      )
      this.shouldPlay = false
      this._play(this.playTime, this.audioTack, this.videoTrack)
    }
  }

  destroyWebsocket() {
    if (this.websocket) {
      this.websocket.removeEventListener(EVENTS.WS_MESSAGE, this.onwsdm)
      this.websocket.onclose = function() {} // disable onclose handler first
      this.websocket.close()
      this.onwsdm = null
    }
  }

  onWebsocketOpen() {
    this.websocket.send('resume')
    this.websocket.removeEventListener(EVENTS.WS_OPEN, this.onwso)
  }

  dispatchMessage(e) {
    try {
      if (this._pause || !this.playing) {
        return
      }

      const rawData = e.data

      if (this._setTracksFlag) {
        this._missed++
        if (!this._missedData) {this._missedData = []}
        this._missedData.push(rawData)
        if (rawData instanceof ArrayBuffer) {
          return;
        }
      }

      if (this._missed > 0) {
          console.log('was missed:', this._missed)
          this._missed = 0;
      }

      if (rawData instanceof ArrayBuffer) {
        if (this._missedData && this._missedData.length) {
          this._missedData.push(rawData)
          const shiftedData = this._missedData.shift()
          let data
          if (shiftedData instanceof ArrayBuffer) {
            data = shiftedData
            console.log('this.doArrayBuffer(rawData, this.maybeAppend)')
            this.doArrayBuffer(data, this.maybeAppend)
          } else {
            debugger
            const parsedData = JSON.parse(shiftedData)
            parsedData.tracks.forEach(t => {
              this.maybeAppend(t.id ,mseUtils.base64ToArrayBuffer(t.payload))
            })
            // data = mseUtils.base64ToArrayBuffer(parsedData.tracks[0].payload)
            // data = mseUtils.base64ToArrayBuffer(parsedData.tracks[0].payload)
            // this.maybeAppend(this.audioTrackId + 1 ,data)
            console.log('this.audioTrackId + 1 ,data')
          }
        } else {
          this.doArrayBuffer(rawData, this.maybeAppend)
        }
      } else {
        this.procInitSegment(rawData)
        this.afterSeekFlag = false
      }
    } catch (err) {
      console.error(mseUtils.errorMsg(e), err)

      if (this.media && this.media.error) {
        console.error('MediaError:', this.media.error)
      }

      if (e.data instanceof ArrayBuffer) {
        console.error('Data:', mseUtils.debugData(e.data))
      }
      errorsCount++
      if (errorsCount >= this.opts.errorsBeforeStop) {
        this.stopPromise = this.stop()
      }

      if (this.onError) {
        this.onError(err, e)
      }
    }
  }

  // there are two cases
  // 1. this.mediaSource is already exists
  // 2. this.meidaSource is undefined
  procInitSegment(rawData) {
    const data = JSON.parse(rawData)
    if (data.type === segmentsTypes.MSE_INIT_SEGMENT) {
      if (this.onMediaInfo) {
        this.mediaInfo = data.metadata
        try {
          this.onMediaInfo(data.metadata)
        } catch (e) {
          console.error(mseUtils.errorMsg(e))
        }
      }

      // 1.
      if (this.mediaSource && !this.mediaSource.sourceBuffers.length) {
        this.createSourceBuffers(data)

        // TODO: describe cases
        data.tracks.forEach(track => {
          this.maybeAppend(track.id, mseUtils.base64ToArrayBuffer(track.payload))
        })

        return
      }

      // 2
      if (this.mediaSource && this.mediaSource.sourceBuffers.length) {
        if (this.afterSeekFlag) {
          data.tracks.forEach(track => {
            this.maybeAppend(track.id, mseUtils.base64ToArrayBuffer(track.payload))
          })
          this.afterSeekFlag = false
          return
        }
        const startOffset = 0
        const endOffset = Infinity
        // TODO: should invoke remove method of SourceBuffer's
        this.flushRange.push({ start: startOffset, end: endOffset, type: void 0 });
        // attempt flush immediately
        this.flushBufferCounter = 0;
        this.doFlush()
      }
      // TODO: describe cases
    } else if (data.type === segmentsTypes.MSE_MEDIA_SEGMENT) {
      this.maybeAppend(data.id, mseUtils.base64ToArrayBuffer(data.payload))
    }
  }

  doFlush () {
    // loop through all buffer ranges to flush
    while (this.flushRange.length) {
      let range = this.flushRange[0];
      // flushBuffer will abort any buffer append in progress and flush Audio/Video Buffer
      if (this.flushBuffer(range.start, range.end, range.type)) {
        // range flushed, remove from flush array
        this.flushRange.shift();
        this.flushBufferCounter = 0;
      } else {
        this._needsFlush = true;
        // avoid looping, wait for SB update end to retrigger a flush
        return;
      }
    }
    if (this.flushRange.length === 0) {
      // everything flushed
      this._needsFlush = false;

      // let's recompute this.appended, which is used to avoid flush looping
      let appended = 0;
      let sourceBuffer = this.sourceBuffer;
      try {
        for (let type in sourceBuffer) {
          appended += sourceBuffer[type].buffered.length;
        }
      } catch (error) {
        // error could be thrown while accessing buffered, in case sourcebuffer has already been removed from MediaSource
        // this is harmess at this stage, catch this to avoid reporting an internal exception
        logger.error('error while accessing sourceBuffer.buffered');
      }
      this.appended = appended;
      this._setTracksFlag = false
      debugger
      // this.hls.trigger(Event.BUFFER_FLUSHED);
    }
  }

  /*
    flush specified buffered range,
    return true once range has been flushed.
    as sourceBuffer.remove() is asynchronous, flushBuffer will be retriggered on sourceBuffer update end
  */
  flushBuffer (startOffset, endOffset, typeIn) {
    let sb, i, bufStart, bufEnd, flushStart, flushEnd, sourceBuffer = this.sourceBuffer;
    if (Object.keys(sourceBuffer).length) {
      logger.log(`flushBuffer,pos/start/end: ${this.media.currentTime.toFixed(3)}/${startOffset}/${endOffset}`);
      // safeguard to avoid infinite looping : don't try to flush more than the nb of appended segments
      if (this.flushBufferCounter < this.appended) {
        for (let type in sourceBuffer) {
          // check if sourcebuffer type is defined (typeIn): if yes, let's only flush this one
          // if no, let's flush all sourcebuffers
          if (typeIn && type !== typeIn) {
            continue;
          }

          sb = sourceBuffer[type];
          // we are going to flush buffer, mark source buffer as 'not ended'
          sb.ended = false;
          if (!sb.updating) {
            try {
              for (i = 0; i < sb.buffered.length; i++) {
                bufStart = sb.buffered.start(i);
                bufEnd = sb.buffered.end(i);
                // workaround firefox not able to properly flush multiple buffered range.
                if (navigator.userAgent.toLowerCase().indexOf('firefox') !== -1 && endOffset === Number.POSITIVE_INFINITY) {
                  flushStart = startOffset;
                  flushEnd = endOffset;
                } else {
                  flushStart = Math.max(bufStart, startOffset);
                  flushEnd = Math.min(bufEnd, endOffset);
                }
                /* sometimes sourcebuffer.remove() does not flush
                   the exact expected time range.
                   to avoid rounding issues/infinite loop,
                   only flush buffer range of length greater than 500ms.
                */
                if (Math.min(flushEnd, bufEnd) - flushStart > 0.5) {
                  this.flushBufferCounter++;
                  logger.log(`flush ${type} [${flushStart},${flushEnd}], of [${bufStart},${bufEnd}], pos:${this.media.currentTime}`);
                  sb.remove(flushStart, flushEnd);
                  return false;
                }
              }
            } catch (e) {
              logger.warn('exception while accessing sourcebuffer, it might have been removed from MediaSource');
            }
          } else {
            // logger.log('abort ' + type + ' append in progress');
            // this will abort any appending in progress
            // sb.abort();
            logger.warn('cannot flush, sb updating in progress');
            return false;
          }
        }
      } else {
        logger.warn('abort flushing too many retries');
      }
      logger.log('buffer flushed');
    }
    // everything flushed !
    return true;
  }

  getVideoTracks() {
    if (!this.mediaInfo) {
      return
    }
    return this.mediaInfo.streams.filter(s => s.content === TYPE_CONTENT_VIDEO)
  }

  getAudioTracks() {
    if (!this.mediaInfo) {
      return
    }
    return this.mediaInfo.streams.filter(s => s.content === TYPE_CONTENT_AUDIO)
  }

  maybeAppend(trackId, binaryData) {
    let buffer
    const trackIdByType = trackId === this.audioTrackId ? this.audioTrackId : 2
    buffer = this._buffers[trackIdByType]

    // let buffer
    // if (trackId === this.audioTrackId) {
      // buffer = this.sourceBuffer[AUDIO]
    // }// else
    // {
      // buffer = this.sourceBuffer[VIDEO]
    // }

    if (this.afterSeekFlag) {

      for(let k in this._buffers) {
        this._buffers[k].abort()
        this._buffers[k].mode = 'sequence'
      }

      this.afterSeekFlag = false
    }

    const queue = this._queues[trackIdByType]
    if (buffer.updating || queue.length > 0) {
      queue.push(binaryData)
    } else {
      buffer.appendBuffer(binaryData)
      this.appended++
      this.appending = true
    }
  }

  startProgressTimer() {
    if (this.onProgress) {
      this.timer = setInterval(this.onTimer.bind(this), this.opts.progressUpdateTime)
    }
  }

  endProgressTimer() {
    clearInterval(this.timer)
    this.timer = void 0
  }

  onTimer() {
    if (!(this.utc && this.utc != this.utcPrev)) {
      return
    }
    try {
      this.onProgress(this.utc)
    } catch (e) {
      console.error(mseUtils.errorMsg(e))
    }

    this.utcPrev = this.utc
  }

  onMediaSourceEnded() {
    console.log('media source ended')
  }

  onMediaSourceClose() {
    console.log('media source closed')
  }

  createSourceBuffers(data) {
    const sourceBuffer = this.sourceBuffer;

    [data.metadata.streams[0], data.metadata.streams[1]]
    //data.metadata.streams.
    .forEach((s, i) => {
      const isVideo = s.content === VIDEO;
      const mimeType = isVideo
        ? 'video/mp4; codecs="avc1.4d401f"'
        : 'audio/mp4; codecs="mp4a.40.2"'

      const id = i + 1 // parseInt(s['track_id'].slice(1), 10)

      if (!isVideo) {
        this.audioTrackId = id
      }

      this._buffers[id] = this.mediaSource.addSourceBuffer(mimeType)



      const buffer = this._buffers[id]

      // video/audio
      sourceBuffer[s.content] = buffer

      buffer.mode = this.opts && this.opts.bufferMode
      this._queues[id] = []
      const queue = this._queues[id]

      buffer.addEventListener(EVENTS.BUFFER_UPDATE_END, updateEnd.bind(this))

      function updateEnd() {
        if (this._needsFlush) {
          debugger
          this.doFlush()
        }
        try {
          if (queue.length > 0 && !buffer.updating) {
            buffer.appendBuffer(queue.shift())
          }
        } catch (e) {
          console.error(mseUtils.errorMsg(e), this.media.error)
        }
      }

    })
    // data.tracks.forEach(track => {
    //   // TODO: use metadata from server
    //   const mimeType = track.content === 'video'
    //     ? 'video/mp4; codecs="avc1.4d401f"'
    //     : 'audio/mp4; codecs="mp4a.40.2"'
    //
    //   this._buffers[track.id] = this.mediaSource.addSourceBuffer(mimeType)
    //   const buffer = this._buffers[track.id]
    //   buffer.mode = this.opts && this.opts.bufferMode
    //   this._queues[track.id] = []
    //   const queue = this._queues[track.id]
    //
    //   buffer.addEventListener(EVENTS.BUFFER_UPDATE_END, updateEnd.bind(this))
    //   buffer.addEventListener(EVENTS.BUFFER_ERROR, onError)
    //   buffer.addEventListener(EVENTS.BUFFER_ABORT, onAbort)
    //
    //   function updateEnd() {
    //     try {
    //       if (queue.length > 0 && !buffer.updating) {
    //         buffer.appendBuffer(queue.shift())
    //       }
    //     } catch (e) {
    //       console.error(mseUtils.errorMsg(e), this.media.error)
    //     }
    //   }
    //
    //   function onError() {
    //     throw new Error('buffer error: ', arguments)
    //   }
    //
    //   function onAbort() {
    //     console.warn('abort buffer')
    //   }
    // })
  }

  onSBUpdateEnd() {
    if (this._needsFlush) {
      debugger
      this.doFlush()
    }
    try {
      if (queue.length > 0 && !buffer.updating) {
        buffer.appendBuffer(queue.shift())
      }
    } catch (e) {
      console.error(mseUtils.errorMsg(e), this.media.error)
    }
    }

  _setTracks(videoTrack, audioTrack) {

    this.media.pause()
    this.websocket.send(`set_tracks=${videoTrack}${audioTrack}`)
    // this._setTracksAttachMediaFlag = true
    this._setTracksFlag = true
    debugger
  }

  setBufferMode(optsOrBufferModeValue) {
    if (typeof optsOrBufferModeValue === 'object') {
      this.opts.bufferMode = optsOrBufferModeValue.bufferMode ? optsOrBufferModeValue.bufferMode : DEFAULT_BUFFER_MODE
    }

    if (typeof optsOrBufferModeValue === 'string') {
      this.opts.bufferMode = optsOrBufferModeValue
    }

    if (this.opts.bufferMode !== BUFFER_MODE_SEGMENTS && this.opts.bufferMode !== BUFFER_MODE_SEQUENCE) {
      throw new Error(
        `invalid bufferMode param, should be undefined or ${BUFFER_MODE_SEGMENTS} or ${BUFFER_MODE_SEQUENCE}.`
      )
    }
  }
}
