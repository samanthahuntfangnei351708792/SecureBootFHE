// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract SecureBootFHE is SepoliaConfig {
    struct FirmwareComponent {
        euint32 encryptedChecksum;
        euint32 encryptedSize;
        euint32 encryptedVersion;
        bool isVerified;
    }

    struct BootStage {
        FirmwareComponent bootloader;
        FirmwareComponent kernel;
        FirmwareComponent rootfs;
        euint32 overallStatus;
        uint256 timestamp;
    }

    mapping(address => BootStage[]) public deviceBootRecords;
    mapping(address => euint32) public trustedChecksums;
    mapping(address => euint32) public trustedSizes;
    mapping(address => euint32) public trustedVersions;
    
    uint256 public verificationThreshold;
    address public admin;
    
    event FirmwareRegistered(address indexed device);
    event BootAttempt(address indexed device, uint256 stageId);
    event VerificationPassed(address indexed device, uint256 stageId);
    event VerificationFailed(address indexed device, uint256 stageId);
    event ThresholdUpdated(uint256 newThreshold);

    constructor(uint256 _threshold) {
        admin = msg.sender;
        verificationThreshold = _threshold;
    }

    modifier onlyAdmin() {
        require(msg.sender == admin, "Admin only");
        _;
    }

    function registerTrustedFirmware(
        address device,
        euint32 checksum,
        euint32 size,
        euint32 version
    ) public onlyAdmin {
        trustedChecksums[device] = checksum;
        trustedSizes[device] = size;
        trustedVersions[device] = version;
        emit FirmwareRegistered(device);
    }

    function verifyBootStage(
        euint32 bootloaderChecksum,
        euint32 bootloaderSize,
        euint32 bootloaderVersion,
        euint32 kernelChecksum,
        euint32 kernelSize,
        euint32 kernelVersion,
        euint32 rootfsChecksum,
        euint32 rootfsSize,
        euint32 rootfsVersion
    ) public {
        address device = msg.sender;
        
        FirmwareComponent memory bootloader = FirmwareComponent({
            encryptedChecksum: bootloaderChecksum,
            encryptedSize: bootloaderSize,
            encryptedVersion: bootloaderVersion,
            isVerified: false
        });
        
        FirmwareComponent memory kernel = FirmwareComponent({
            encryptedChecksum: kernelChecksum,
            encryptedSize: kernelSize,
            encryptedVersion: kernelVersion,
            isVerified: false
        });
        
        FirmwareComponent memory rootfs = FirmwareComponent({
            encryptedChecksum: rootfsChecksum,
            encryptedSize: rootfsSize,
            encryptedVersion: rootfsVersion,
            isVerified: false
        });

        euint32 bootloaderValid = verifyComponent(device, bootloader);
        euint32 kernelValid = verifyComponent(device, kernel);
        euint32 rootfsValid = verifyComponent(device, rootfs);

        euint32 overallStatus = FHE.asEuint32(0);
        overallStatus = FHE.add(overallStatus, bootloaderValid);
        overallStatus = FHE.add(overallStatus, kernelValid);
        overallStatus = FHE.add(overallStatus, rootfsValid);

        uint256 stageId = deviceBootRecords[device].length;
        deviceBootRecords[device].push(BootStage({
            bootloader: bootloader,
            kernel: kernel,
            rootfs: rootfs,
            overallStatus: overallStatus,
            timestamp: block.timestamp
        }));

        emit BootAttempt(device, stageId);

        if (FHE.gt(overallStatus, FHE.asEuint32(uint32(verificationThreshold)))) {
            deviceBootRecords[device][stageId].bootloader.isVerified = true;
            deviceBootRecords[device][stageId].kernel.isVerified = true;
            deviceBootRecords[device][stageId].rootfs.isVerified = true;
            emit VerificationPassed(device, stageId);
        } else {
            emit VerificationFailed(device, stageId);
        }
    }

    function verifyComponent(address device, FirmwareComponent memory component) private view returns (euint32) {
        euint32 checksumValid = FHE.eq(component.encryptedChecksum, trustedChecksums[device]);
        euint32 sizeValid = FHE.eq(component.encryptedSize, trustedSizes[device]);
        euint32 versionValid = FHE.gt(component.encryptedVersion, FHE.asEuint32(0));
        
        euint32 componentScore = FHE.asEuint32(0);
        componentScore = FHE.add(componentScore, FHE.select(checksumValid, FHE.asEuint32(1), FHE.asEuint32(0)));
        componentScore = FHE.add(componentScore, FHE.select(sizeValid, FHE.asEuint32(1), FHE.asEuint32(0)));
        componentScore = FHE.add(componentScore, FHE.select(versionValid, FHE.asEuint32(1), FHE.asEuint32(0)));
        
        return componentScore;
    }

    function requestBootStatusDecryption(uint256 stageId) public {
        address device = msg.sender;
        require(stageId < deviceBootRecords[device].length, "Invalid stage ID");
        
        BootStage storage stage = deviceBootRecords[device][stageId];
        bytes32[] memory ciphertexts = new bytes32[](1);
        ciphertexts[0] = FHE.toBytes32(stage.overallStatus);
        
        uint256 reqId = FHE.requestDecryption(ciphertexts, this.decryptBootStatus.selector);
    }

    function decryptBootStatus(
        uint256 requestId,
        bytes memory cleartexts,
        bytes memory proof
    ) public {
        FHE.checkSignatures(requestId, cleartexts, proof);
        
        uint32 status = abi.decode(cleartexts, (uint32));
        address device = msg.sender;
        uint256 latestStage = deviceBootRecords[device].length - 1;
        
        if (status > uint32(verificationThreshold)) {
            deviceBootRecords[device][latestStage].bootloader.isVerified = true;
            deviceBootRecords[device][latestStage].kernel.isVerified = true;
            deviceBootRecords[device][latestStage].rootfs.isVerified = true;
        }
    }

    function updateVerificationThreshold(uint256 newThreshold) public onlyAdmin {
        verificationThreshold = newThreshold;
        emit ThresholdUpdated(newThreshold);
    }

    function getBootStageCount(address device) public view returns (uint256) {
        return deviceBootRecords[device].length;
    }

    function getBootStageStatus(address device, uint256 stageId) public view returns (
        bool bootloaderVerified,
        bool kernelVerified,
        bool rootfsVerified,
        uint256 timestamp
    ) {
        require(stageId < deviceBootRecords[device].length, "Invalid stage ID");
        BootStage storage stage = deviceBootRecords[device][stageId];
        return (
            stage.bootloader.isVerified,
            stage.kernel.isVerified,
            stage.rootfs.isVerified,
            stage.timestamp
        );
    }
}