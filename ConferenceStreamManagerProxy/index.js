/*
Copyright © 2015 Infrared5, Inc. All rights reserved.

The accompanying code comprising examples for use solely in conjunction with Red5 Pro (the "Example Code")
is  licensed  to  you  by  Infrared5  Inc.  in  consideration  of  your  agreement  to  the  following
license terms  and  conditions.  Access,  use,  modification,  or  redistribution  of  the  accompanying
code  constitutes your acceptance of the following license terms and conditions.

Permission is hereby granted, free of charge, to you to use the Example Code and associated documentation
files (collectively, the "Software") without restriction, including without limitation the rights to use,
copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
persons to whom the Software is furnished to do so, subject to the following conditions:

The Software shall be used solely in conjunction with Red5 Pro. Red5 Pro is licensed under a separate end
user  license  agreement  (the  "EULA"),  which  must  be  executed  with  Infrared5,  Inc.
An  example  of  the EULA can be found on our website at: https://account.red5pro.com/assets/LICENSE.txt.

The above copyright notice and this license shall be included in all copies or portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,  INCLUDING  BUT
NOT  LIMITED  TO  THE  WARRANTIES  OF  MERCHANTABILITY, FITNESS  FOR  A  PARTICULAR  PURPOSE  AND
NONINFRINGEMENT.   IN  NO  EVENT  SHALL INFRARED5, INC. BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
WHETHER IN  AN  ACTION  OF  CONTRACT,  TORT  OR  OTHERWISE,  ARISING  FROM,  OUT  OF  OR  IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/
;(function (window, document, red5prosdk) {
  'use strict'

  var isPublishing = false

  var serverSettings = (function () {
    var settings = sessionStorage.getItem('r5proServerSettings')
    try {
      return JSON.parse(settings)
    } catch (e) {
      console.error(
        'Could not read server settings from sessionstorage: ' + e.message
      )
    }
    return {}
  })()

  var configuration = (function () {
    var conf = sessionStorage.getItem('r5proTestBed')
    try {
      return JSON.parse(conf)
    } catch (e) {
      console.error(
        'Could not read testbed configuration from sessionstorage: ' + e.message
      )
    }
    return {}
  })()
  red5prosdk.setLogLevel(
    configuration.verboseLogging
      ? red5prosdk.LOG_LEVELS.TRACE
      : red5prosdk.LOG_LEVELS.WARN
  )

  var updateStatusFromEvent = window.red5proHandlePublisherEvent // defined in src/template/partial/status-field-publisher.hbs

  var targetPublisher
  var mediaStream
  var mediaStreamConstraints
  var hostSocket
  var roomName = window.query('room') || 'red5pro' // eslint-disable-line no-unused-vars
  var streamName =
    window.query('streamName') ||
    ['publisher', Math.floor(Math.random() * 0x10000).toString(16)].join('-')
  var socketEndpoint = window.query('socket') || 'localhost:8001'

  var roomField = document.getElementById('room-field')
  // eslint-disable-next-line no-unused-vars
  var publisherContainer = document.getElementById('publisher-container')
  var publisherMuteControls = document.getElementById('publisher-mute-controls')
  var publisherSession = document.getElementById('publisher-session')
  var publisherNameField = document.getElementById('publisher-name-field')
  var streamNameField = document.getElementById('streamname-field')
  var publisherVideo = document.getElementById('red5pro-publisher')
  var audioCheck = document.getElementById('audio-check')
  var videoCheck = document.getElementById('video-check')
  var joinButton = document.getElementById('join-button')
  var statisticsField = document.getElementById('statistics-field')
  var bitrateField = document.getElementById('bitrate-field')
  var packetsField = document.getElementById('packets-field')
  var resolutionField = document.getElementById('resolution-field')
  var bitrateTrackingTicket
  var bitrate = 0
  var packetsSent = 0
  var frameWidth = 0
  var frameHeight = 0

  function updateStatistics(b, p, w, h) {
    statisticsField.classList.remove('hidden')
    bitrateField.innerText = b === 0 ? 'N/A' : Math.floor(b)
    packetsField.innerText = p
    resolutionField.innerText = (w || 0) + 'x' + (h || 0)
  }

  function onBitrateUpdate(b, p) {
    bitrate = b
    packetsSent = p
    updateStatistics(bitrate, packetsSent, frameWidth, frameHeight)
    if (packetsSent > 100) {
      establishSocketHost(
        targetPublisher,
        roomField.value,
        streamNameField.value
      )
    }
  }

  function onResolutionUpdate(w, h) {
    frameWidth = w
    frameHeight = h
    updateStatistics(bitrate, packetsSent, frameWidth, frameHeight)
  }

  roomField.value = roomName
  streamNameField.value = streamName
  audioCheck.checked = configuration.useAudio
  videoCheck.checked = configuration.useVideo

  joinButton.addEventListener('click', function () {
    saveSettings()
    doPublish(mediaStream, roomName, streamName)
    setPublishingUI(streamName)
  })

  audioCheck.addEventListener('change', updateMutedAudioOnPublisher)
  videoCheck.addEventListener('change', updateMutedVideoOnPublisher)

  var protocol = serverSettings.protocol
  var isSecure = protocol == 'https'

  function saveSettings() {
    streamName = streamNameField.value
    roomName = roomField.value
  }

  function updateMutedAudioOnPublisher() {
    if (targetPublisher && isPublishing) {
      var c = targetPublisher.getPeerConnection()
      var senders = c.getSenders()
      var params = senders[0].getParameters()
      if (audioCheck.checked) {
        if (audioTrackClone) {
          senders[0].replaceTrack(audioTrackClone)
          audioTrackClone = undefined
        } else {
          try {
            targetPublisher.unmuteAudio()
            params.encodings[0].active = true
            senders[0].setParameters(params)
          } catch (e) {
            // no browser support, let's use mute API.
            targetPublisher.unmuteAudio()
          }
        }
      } else {
        try {
          targetPublisher.muteAudio()
          params.encodings[0].active = false
          senders[0].setParameters(params)
        } catch (e) {
          // no browser support, let's use mute API.
          targetPublisher.muteAudio()
        }
      }
    }
  }

  function updateMutedVideoOnPublisher() {
    if (targetPublisher && isPublishing) {
      if (videoCheck.checked) {
        if (videoTrackClone) {
          var c = targetPublisher.getPeerConnection()
          var senders = c.getSenders()
          senders[1].replaceTrack(videoTrackClone)
          videoTrackClone = undefined
        } else {
          targetPublisher.unmuteVideo()
        }
      } else {
        targetPublisher.muteVideo()
      }
    }
    !videoCheck.checked && showVideoPoster()
    videoCheck.checked && hideVideoPoster()
  }

  var audioTrackClone
  var videoTrackClone
  function updateInitialMediaOnPublisher() {
    var t = setTimeout(function () {
      // If we have requested no audio and/or no video in our initial broadcast,
      // wipe the track from the connection.
      var audioTrack = targetPublisher.getMediaStream().getAudioTracks()[0]
      var videoTrack = targetPublisher.getMediaStream().getVideoTracks()[0]
      var connection = targetPublisher.getPeerConnection()
      if (!videoCheck.checked) {
        videoTrackClone = videoTrack.clone()
        connection.getSenders()[1].replaceTrack(null)
      }
      if (!audioCheck.checked) {
        audioTrackClone = audioTrack.clone()
        connection.getSenders()[0].replaceTrack(null)
      }
      clearTimeout(t)
    }, 2000)
    // a bit of a hack. had to put a timeout to ensure the video track bits at least started flowing :/
  }

  function showVideoPoster() {
    publisherVideo.classList.add('hidden')
  }

  function hideVideoPoster() {
    publisherVideo.classList.remove('hidden')
  }

  function getSocketLocationFromProtocol() {
    return !isSecure
      ? { protocol: 'ws', port: serverSettings.wsport }
      : { protocol: 'wss', port: serverSettings.wssport }
  }

  function onPublisherEvent(event) {
    console.log('[Red5ProPublisher] ' + event.type + '.')
    if (event.type === 'WebSocket.Message.Unhandled') {
      console.log(event)
    }
    updateStatusFromEvent(event)
  }
  function onPublishFail(message) {
    isPublishing = false
    console.error('[Red5ProPublisher] Publish Error :: ' + message)
  }
  function onPublishSuccess(publisher) {
    isPublishing = true
    window.red5propublisher = publisher
    console.log('[Red5ProPublisher] Publish Complete.')
    // [NOTE] Moving SO setup until Package Sent amount is sufficient.
    try {
      var pc = publisher.getPeerConnection()
      var stream = publisher.getMediaStream()
      bitrateTrackingTicket = window.trackBitrate(
        pc,
        onBitrateUpdate,
        null,
        null,
        true
      )
      statisticsField.classList.remove('hidden')
      stream.getVideoTracks().forEach(function (track) {
        var settings = track.getSettings()
        onResolutionUpdate(settings.width, settings.height)
      })
    } catch (e) {
      // no tracking for you!
    }
  }
  function onUnpublishFail(message) {
    isPublishing = false
    console.error('[Red5ProPublisher] Unpublish Error :: ' + message)
  }
  function onUnpublishSuccess() {
    isPublishing = false
    console.log('[Red5ProPublisher] Unpublish Complete.')
  }

  function getAuthenticationParams() {
    var auth = configuration.authentication
    return auth && auth.enabled
      ? {
          connectionParams: {
            username: auth.username,
            password: auth.password,
            token: auth.token,
          },
        }
      : {}
  }

  function setPublishingUI(streamName) {
    publisherNameField.innerText = streamName
    roomField.setAttribute('disabled', true)
    publisherSession.classList.remove('hidden')
    publisherNameField.classList.remove('hidden')
    publisherMuteControls.classList.remove('hidden')
    Array.prototype.forEach.call(
      document.getElementsByClassName('remove-on-broadcast'),
      function (el) {
        el.classList.add('hidden')
      }
    )
  }

  // eslint-disable-next-line no-unused-vars
  function updatePublishingUIOnStreamCount(streamCount) {
    /*
    if (streamCount > 0) {
      publisherContainer.classList.remove('margin-center');
    } else {
      publisherContainer.classList.add('margin-center');
    }
    */
  }

  function establishSocketHost(publisher, roomName, streamName) {
    if (hostSocket) return
    var wsProtocol = isSecure ? 'wss' : 'ws'
    var url = `${wsProtocol}://${socketEndpoint}?room=${roomName}&streamName=${streamName}`
    hostSocket = new WebSocket(url)
    hostSocket.onmessage = function (message) {
      var payload = JSON.parse(message.data)
      if (roomName === payload.room) {
        processStreams(payload.streams, streamsList, roomName, streamName)
      }
    }
  }

  function getUserMediaConfiguration() {
    return {
      mediaConstraints: {
        audio: configuration.useAudio
          ? configuration.mediaConstraints.audio
          : false,
        video: configuration.useVideo
          ? configuration.mediaConstraints.video
          : false,
      },
    }
  }

  const determinePublisher = async (mediaStream, room, name, bitrate = 256) => {
    const { app, preferWhipWhep } = configuration
    const { WHIPClient, RTCPublisher } = red5prosdk
    let config = Object.assign(
      {},
      configuration,
      {
        streamMode: configuration.recordBroadcast ? 'record' : 'live',
      },
      getAuthenticationParams(),
      getUserMediaConfiguration()
    )

    let rtcConfig = Object.assign({}, config, {
      protocol: getSocketLocationFromProtocol().protocol,
      port: getSocketLocationFromProtocol().port,
      bandwidth: {
        video: bitrate,
      },
      app: `${app}/${room}`,
      streamName: name,
    })

    if (!preferWhipWhep) {
      let connectionParams = rtcConfig.connectionParams
        ? rtcConfig.connectionParams
        : {}
      const payload = await window.streamManagerUtil.getOrigin(
        rtcConfig.host,
        rtcConfig.app,
        name
      )
      const { scope, serverAddress } = payload
      rtcConfig = {
        ...rtcConfig,
        ...{
          app: 'streammanager',
          connectionParams: {
            ...connectionParams,
            ...{
              host: serverAddress,
              app: scope,
            },
          },
        },
      }
    }
    console.log('PUBLISH', name, rtcConfig)
    var publisher = preferWhipWhep ? new WHIPClient() : new RTCPublisher()
    return await publisher.initWithStream(rtcConfig, mediaStream)
  }

  const doPublish = async (stream, room, name) => {
    try {
      targetPublisher = await determinePublisher(stream, room, name, bitrate)
      targetPublisher.on('*', onPublisherEvent)
      await targetPublisher.publish()
      onPublishSuccess(targetPublisher)
      setPublishingUI(name)
    } catch (error) {
      var jsonError =
        typeof error === 'string' ? error : JSON.stringify(error, null, 2)
      console.error('[Red5ProPublisher] :: Error in publishing - ' + jsonError)
      console.error(error)
      onPublishFail(jsonError)
    }
  }

  function unpublish() {
    if (hostSocket !== undefined) {
      hostSocket.close()
    }
    return new Promise(function (resolve, reject) {
      var publisher = targetPublisher
      publisher
        .unpublish()
        .then(function () {
          onUnpublishSuccess()
          resolve()
        })
        .catch(function (error) {
          var jsonError =
            typeof error === 'string' ? error : JSON.stringify(error, 2, null)
          onUnpublishFail('Unmount Error ' + jsonError)
          reject(error)
        })
    })
  }

  const startPreview = async () => {
    const element = document.querySelector('#red5pro-publisher')
    const constraints = {
      audio: true,
      video: {
        width: {
          exact: 640,
        },
        height: {
          exact: 480,
        },
        frameRate: {
          min: 15,
        },
      },
    }
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia(constraints)
      mediaStreamConstraints = constraints
      element.srcObject = mediaStream
      window.allowMediaStreamSwap(
        element,
        constraints,
        mediaStream,
        (activeStream, activeConstraints) => {
          mediaStream = activeStream
          mediaStreamConstraints = activeConstraints
          console.log(mediaStream, mediaStreamConstraints)
          // If we have a broadcast going, just swap tracks live.
          if (targetPublisher && targetPublisher.getPeerConnection()) {
            const connection = targetPublisher.getPeerConnection()
            const senders = connection.getSenders()
            const videoTrack = mediaStream.getVideoTracks()[0]
            const audioTrack = mediaStream.getAudioTracks()[0]
            if (videoTrack) {
              const video = senders.find(
                (s) => s.track.kind === videoTrack.kind
              )
              video.replaceTrack(videoTrack)
            }
            if (audioTrack) {
              const audio = senders.find(
                (s) => s.track.kind === audioTrack.kind
              )
              audio.replaceTrack(audioTrack)
            }
          }
        }
      )
    } catch (e) {
      console.error(e)
    }
  }
  startPreview()

  var shuttingDown = false
  function shutdown() {
    if (shuttingDown) return
    shuttingDown = true
    function clearRefs() {
      if (targetPublisher) {
        targetPublisher.off('*', onPublisherEvent)
      }
      targetPublisher = undefined
    }
    unpublish().then(clearRefs).catch(clearRefs)
    window.untrackBitrate(bitrateTrackingTicket)
  }
  window.addEventListener('beforeunload', shutdown)
  window.addEventListener('pagehide', shutdown)

  var streamsList = []
  var subscribersEl = document.getElementById('subscribers')
  function processStreams(list, previousList, roomName, exclusion) {
    var nonPublishers = list.filter(function (name) {
      return name !== exclusion
    })
    var existing = nonPublishers.filter((name, index, self) => {
      return index == self.indexOf(name) && previousList.indexOf(name) !== -1
    })
    var toAdd = nonPublishers.filter(function (name, index, self) {
      return index == self.indexOf(name) && previousList.indexOf(name) === -1
    })
    var toRemove = previousList.filter((name, index, self) => {
      return index == self.indexOf(name) && list.indexOf(name) === -1
    })
    window.ConferenceSubscriberUtil.removeAll(toRemove)
    streamsList = list

    var subscribers = toAdd.map(function (name, index) {
      return new window.ConferenceSubscriberItem(
        name,
        subscribersEl,
        index,
        () => {}
      )
    })

    // Below is a linked list to subscriber sequentially.
    /*
    var i, length = subscribers.length - 1;
    var sub;
    for(i = 0; i < length; i++) {
      sub = subscribers[i];
      sub.next = subscribers[sub.index+1];
    }
    */
    if (subscribers.length > 0) {
      const { app, preferWhipWhep } = configuration
      var baseSubscriberConfig = Object.assign(
        {},
        configuration,
        {
          protocol: getSocketLocationFromProtocol().protocol,
          port: getSocketLocationFromProtocol().port,
          app: `${app}/${roomName}`,
        },
        getAuthenticationParams()
      )
      subscribers.forEach((s) =>
        s.execute(baseSubscriberConfig, preferWhipWhep)
      )
      // Below is to be used if using sequential subsciber logic explained above.
      //      subscribers[0].execute(baseSubscriberConfig);
    }

    updatePublishingUIOnStreamCount(nonPublishers.length)
  }
})(this, document, window.red5prosdk)
