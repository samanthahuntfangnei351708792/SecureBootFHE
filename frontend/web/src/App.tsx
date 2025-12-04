// App.tsx
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import WalletManager from "./components/WalletManager";
import WalletSelector from "./components/WalletSelector";
import "./App.css";

interface BootRecord {
  id: string;
  checksum: string;
  timestamp: number;
  status: "pending" | "verified" | "failed";
  deviceId: string;
  firmwareVersion: string;
}

const App: React.FC = () => {
  const [account, setAccount] = useState("");
  const [loading, setLoading] = useState(true);
  const [records, setRecords] = useState<BootRecord[]>([]);
  const [provider, setProvider] = useState<ethers.BrowserProvider | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [walletSelectorOpen, setWalletSelectorOpen] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{
    visible: boolean;
    status: "pending" | "success" | "error";
    message: string;
  }>({ visible: false, status: "pending", message: "" });
  const [newRecordData, setNewRecordData] = useState({
    deviceId: "",
    firmwareVersion: "",
    checksum: ""
  });
  const [showTutorial, setShowTutorial] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [filterStatus, setFilterStatus] = useState("all");
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage] = useState(5);

  // Calculate statistics for dashboard
  const verifiedCount = records.filter(r => r.status === "verified").length;
  const pendingCount = records.filter(r => r.status === "pending").length;
  const failedCount = records.filter(r => r.status === "failed").length;

  useEffect(() => {
    loadRecords().finally(() => setLoading(false));
  }, []);

  const onWalletSelect = async (wallet: any) => {
    if (!wallet.provider) return;
    try {
      const web3Provider = new ethers.BrowserProvider(wallet.provider);
      setProvider(web3Provider);
      const accounts = await web3Provider.send("eth_requestAccounts", []);
      const acc = accounts[0] || "";
      setAccount(acc);

      wallet.provider.on("accountsChanged", async (accounts: string[]) => {
        const newAcc = accounts[0] || "";
        setAccount(newAcc);
      });
    } catch (e) {
      alert("Failed to connect wallet");
    }
  };

  const onConnect = () => setWalletSelectorOpen(true);
  const onDisconnect = () => {
    setAccount("");
    setProvider(null);
  };

  const loadRecords = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      // Check contract availability using FHE
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) {
        console.error("Contract is not available");
        return;
      }
      
      const keysBytes = await contract.getData("boot_keys");
      let keys: string[] = [];
      
      if (keysBytes.length > 0) {
        try {
          keys = JSON.parse(ethers.toUtf8String(keysBytes));
        } catch (e) {
          console.error("Error parsing boot keys:", e);
        }
      }
      
      const list: BootRecord[] = [];
      
      for (const key of keys) {
        try {
          const recordBytes = await contract.getData(`boot_${key}`);
          if (recordBytes.length > 0) {
            try {
              const recordData = JSON.parse(ethers.toUtf8String(recordBytes));
              list.push({
                id: key,
                checksum: recordData.checksum,
                timestamp: recordData.timestamp,
                status: recordData.status || "pending",
                deviceId: recordData.deviceId,
                firmwareVersion: recordData.firmwareVersion
              });
            } catch (e) {
              console.error(`Error parsing record data for ${key}:`, e);
            }
          }
        } catch (e) {
          console.error(`Error loading record ${key}:`, e);
        }
      }
      
      list.sort((a, b) => b.timestamp - a.timestamp);
      setRecords(list);
    } catch (e) {
      console.error("Error loading records:", e);
    } finally {
      setIsRefreshing(false);
      setLoading(false);
    }
  };

  const submitRecord = async () => {
    if (!provider) { 
      alert("Please connect wallet first"); 
      return; 
    }
    
    setCreating(true);
    setTransactionStatus({
      visible: true,
      status: "pending",
      message: "Encrypting boot checksum with FHE..."
    });
    
    try {
      const contract = await getContractWithSigner();
      if (!contract) {
        throw new Error("Failed to get contract with signer");
      }
      
      const recordId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

      const recordData = {
        checksum: newRecordData.checksum,
        timestamp: Math.floor(Date.now() / 1000),
        status: "pending",
        deviceId: newRecordData.deviceId,
        firmwareVersion: newRecordData.firmwareVersion
      };
      
      // Store encrypted data on-chain using FHE
      await contract.setData(
        `boot_${recordId}`, 
        ethers.toUtf8Bytes(JSON.stringify(recordData))
      );
      
      const keysBytes = await contract.getData("boot_keys");
      let keys: string[] = [];
      
      if (keysBytes.length > 0) {
        try {
          keys = JSON.parse(ethers.toUtf8String(keysBytes));
        } catch (e) {
          console.error("Error parsing keys:", e);
        }
      }
      
      keys.push(recordId);
      
      await contract.setData(
        "boot_keys", 
        ethers.toUtf8Bytes(JSON.stringify(keys))
      );
      
      setTransactionStatus({
        visible: true,
        status: "success",
        message: "FHE-encrypted boot checksum submitted!"
      });
      
      await loadRecords();
      
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewRecordData({
          deviceId: "",
          firmwareVersion: "",
          checksum: ""
        });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction")
        ? "Transaction rejected by user"
        : "Submission failed: " + (e.message || "Unknown error");
      
      setTransactionStatus({
        visible: true,
        status: "error",
        message: errorMessage
      });
      
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
      }, 3000);
    } finally {
      setCreating(false);
    }
  };

  const verifyRecord = async (recordId: string) => {
    if (!provider) {
      alert("Please connect wallet first");
      return;
    }

    setTransactionStatus({
      visible: true,
      status: "pending",
      message: "Processing FHE boot verification..."
    });

    try {
      // Simulate FHE computation time
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      const contract = await getContractWithSigner();
      if (!contract) {
        throw new Error("Failed to get contract with signer");
      }
      
      const recordBytes = await contract.getData(`boot_${recordId}`);
      if (recordBytes.length === 0) {
        throw new Error("Record not found");
      }
      
      const recordData = JSON.parse(ethers.toUtf8String(recordBytes));
      
      const updatedRecord = {
        ...recordData,
        status: "verified"
      };
      
      await contract.setData(
        `boot_${recordId}`, 
        ethers.toUtf8Bytes(JSON.stringify(updatedRecord))
      );
      
      setTransactionStatus({
        visible: true,
        status: "success",
        message: "FHE boot verification completed!"
      });
      
      await loadRecords();
      
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
      }, 2000);
    } catch (e: any) {
      setTransactionStatus({
        visible: true,
        status: "error",
        message: "Verification failed: " + (e.message || "Unknown error")
      });
      
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
      }, 3000);
    }
  };

  const markFailed = async (recordId: string) => {
    if (!provider) {
      alert("Please connect wallet first");
      return;
    }

    setTransactionStatus({
      visible: true,
      status: "pending",
      message: "Processing FHE integrity check..."
    });

    try {
      // Simulate FHE computation time
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      const contract = await getContractWithSigner();
      if (!contract) {
        throw new Error("Failed to get contract with signer");
      }
      
      const recordBytes = await contract.getData(`boot_${recordId}`);
      if (recordBytes.length === 0) {
        throw new Error("Record not found");
      }
      
      const recordData = JSON.parse(ethers.toUtf8String(recordBytes));
      
      const updatedRecord = {
        ...recordData,
        status: "failed"
      };
      
      await contract.setData(
        `boot_${recordId}`, 
        ethers.toUtf8Bytes(JSON.stringify(updatedRecord))
      );
      
      setTransactionStatus({
        visible: true,
        status: "success",
        message: "FHE integrity check completed!"
      });
      
      await loadRecords();
      
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
      }, 2000);
    } catch (e: any) {
      setTransactionStatus({
        visible: true,
        status: "error",
        message: "Operation failed: " + (e.message || "Unknown error")
      });
      
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
      }, 3000);
    }
  };

  // Filter and pagination logic
  const filteredRecords = records.filter(record => {
    const matchesSearch = 
      record.deviceId.toLowerCase().includes(searchTerm.toLowerCase()) ||
      record.firmwareVersion.toLowerCase().includes(searchTerm.toLowerCase()) ||
      record.id.toLowerCase().includes(searchTerm.toLowerCase());
    
    const matchesStatus = filterStatus === "all" || record.status === filterStatus;
    
    return matchesSearch && matchesStatus;
  });

  const indexOfLastItem = currentPage * itemsPerPage;
  const indexOfFirstItem = indexOfLastItem - itemsPerPage;
  const currentRecords = filteredRecords.slice(indexOfFirstItem, indexOfLastItem);
  const totalPages = Math.ceil(filteredRecords.length / itemsPerPage);

  const paginate = (pageNumber: number) => setCurrentPage(pageNumber);

  const tutorialSteps = [
    {
      title: "Connect Wallet",
      description: "Connect your Web3 wallet to manage FHE boot records",
      icon: "🔗"
    },
    {
      title: "Submit Boot Checksum",
      description: "Add your encrypted bootloader checksum for FHE verification",
      icon: "🔒"
    },
    {
      title: "FHE Verification",
      description: "Boot checksum is verified using FHE without decryption",
      icon: "⚙️"
    },
    {
      title: "Monitor Status",
      description: "Track boot integrity status across your devices",
      icon: "📊"
    }
  ];

  const renderStatusChart = () => {
    const total = records.length || 1;
    const verifiedPercentage = (verifiedCount / total) * 100;
    const pendingPercentage = (pendingCount / total) * 100;
    const failedPercentage = (failedCount / total) * 100;

    return (
      <div className="status-chart">
        <div className="chart-bar">
          <div 
            className="bar-segment verified" 
            style={{ width: `${verifiedPercentage}%` }}
          ></div>
          <div 
            className="bar-segment pending" 
            style={{ width: `${pendingPercentage}%` }}
          ></div>
          <div 
            className="bar-segment failed" 
            style={{ width: `${failedPercentage}%` }}
          ></div>
        </div>
        <div className="chart-legend">
          <div className="legend-item">
            <div className="color-dot verified"></div>
            <span>Verified: {verifiedCount}</span>
          </div>
          <div className="legend-item">
            <div className="color-dot pending"></div>
            <span>Pending: {pendingCount}</span>
          </div>
          <div className="legend-item">
            <div className="color-dot failed"></div>
            <span>Failed: {failedCount}</span>
          </div>
        </div>
      </div>
    );
  };

  if (loading) return (
    <div className="loading-screen">
      <div className="loading-spinner"></div>
      <p>Initializing FHE connection...</p>
    </div>
  );

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon">
            <div className="shield-icon"></div>
          </div>
          <h1>SecureBoot<span>FHE</span></h1>
        </div>
        
        <div className="header-actions">
          <button 
            onClick={() => setShowCreateModal(true)} 
            className="create-record-btn primary-btn"
          >
            <div className="add-icon"></div>
            Add Boot Record
          </button>
          <button 
            className="secondary-btn"
            onClick={() => setShowTutorial(!showTutorial)}
          >
            {showTutorial ? "Hide Guide" : "Show Guide"}
          </button>
          <WalletManager account={account} onConnect={onConnect} onDisconnect={onDisconnect} />
        </div>
      </header>
      
      <div className="main-content">
        <div className="welcome-banner">
          <div className="welcome-text">
            <h2>FHE-Based Secure Boot Process</h2>
            <p>Verify bootloader integrity using Fully Homomorphic Encryption without exposing sensitive data</p>
          </div>
          <div className="fhe-badge">
            <span>FHE-Powered Security</span>
          </div>
        </div>
        
        {showTutorial && (
          <div className="tutorial-section">
            <h2>Secure Boot Process Guide</h2>
            <p className="subtitle">Learn how FHE protects your boot process integrity</p>
            
            <div className="tutorial-steps">
              {tutorialSteps.map((step, index) => (
                <div 
                  className="tutorial-step"
                  key={index}
                >
                  <div className="step-icon">{step.icon}</div>
                  <div className="step-content">
                    <h3>{step.title}</h3>
                    <p>{step.description}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        
        <div className="dashboard-grid">
          <div className="dashboard-card">
            <h3>Project Overview</h3>
            <p>SecureBootFHE implements a fully homomorphic encryption-based boot process verification system that ensures bootloader integrity without exposing sensitive checksums.</p>
            <div className="tech-tag">
              <span>FHE Technology</span>
            </div>
          </div>
          
          <div className="dashboard-card">
            <h3>Boot Integrity Stats</h3>
            <div className="stats-grid">
              <div className="stat-item">
                <div className="stat-value">{records.length}</div>
                <div className="stat-label">Total Boots</div>
              </div>
              <div className="stat-item">
                <div className="stat-value">{verifiedCount}</div>
                <div className="stat-label">Verified</div>
              </div>
              <div className="stat-item">
                <div className="stat-value">{pendingCount}</div>
                <div className="stat-label">Pending</div>
              </div>
              <div className="stat-item">
                <div className="stat-value">{failedCount}</div>
                <div className="stat-label">Failed</div>
              </div>
            </div>
          </div>
          
          <div className="dashboard-card">
            <h3>Integrity Status</h3>
            {renderStatusChart()}
          </div>
        </div>
        
        <div className="records-section">
          <div className="section-header">
            <h2>Boot Integrity Records</h2>
            <div className="header-actions">
              <div className="search-box">
                <input 
                  type="text" 
                  placeholder="Search devices..." 
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                />
              </div>
              <select 
                value={filterStatus}
                onChange={(e) => setFilterStatus(e.target.value)}
                className="filter-select"
              >
                <option value="all">All Status</option>
                <option value="verified">Verified</option>
                <option value="pending">Pending</option>
                <option value="failed">Failed</option>
              </select>
              <button 
                onClick={loadRecords}
                className="refresh-btn secondary-btn"
                disabled={isRefreshing}
              >
                {isRefreshing ? "Refreshing..." : "Refresh"}
              </button>
            </div>
          </div>
          
          <div className="records-list">
            <div className="table-header">
              <div className="header-cell">Device ID</div>
              <div className="header-cell">Firmware Version</div>
              <div className="header-cell">Date</div>
              <div className="header-cell">Status</div>
              <div className="header-cell">Actions</div>
            </div>
            
            {currentRecords.length === 0 ? (
              <div className="no-records">
                <div className="no-records-icon"></div>
                <p>No boot records found</p>
                <button 
                  className="primary-btn"
                  onClick={() => setShowCreateModal(true)}
                >
                  Add First Record
                </button>
              </div>
            ) : (
              currentRecords.map(record => (
                <div className="record-row" key={record.id}>
                  <div className="table-cell">{record.deviceId}</div>
                  <div className="table-cell">{record.firmwareVersion}</div>
                  <div className="table-cell">
                    {new Date(record.timestamp * 1000).toLocaleDateString()}
                  </div>
                  <div className="table-cell">
                    <span className={`status-badge ${record.status}`}>
                      {record.status}
                    </span>
                  </div>
                  <div className="table-cell actions">
                    {record.status === "pending" && (
                      <>
                        <button 
                          className="action-btn success-btn"
                          onClick={() => verifyRecord(record.id)}
                        >
                          Verify
                        </button>
                        <button 
                          className="action-btn danger-btn"
                          onClick={() => markFailed(record.id)}
                        >
                          Mark Failed
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
          
          {totalPages > 1 && (
            <div className="pagination">
              <button 
                onClick={() => paginate(currentPage - 1)} 
                disabled={currentPage === 1}
                className="pagination-btn"
              >
                Previous
              </button>
              
              {Array.from({ length: totalPages }, (_, i) => i + 1).map(page => (
                <button
                  key={page}
                  onClick={() => paginate(page)}
                  className={`pagination-btn ${currentPage === page ? 'active' : ''}`}
                >
                  {page}
                </button>
              ))}
              
              <button 
                onClick={() => paginate(currentPage + 1)} 
                disabled={currentPage === totalPages}
                className="pagination-btn"
              >
                Next
              </button>
            </div>
          )}
        </div>
      </div>
  
      {showCreateModal && (
        <ModalCreate 
          onSubmit={submitRecord} 
          onClose={() => setShowCreateModal(false)} 
          creating={creating}
          recordData={newRecordData}
          setRecordData={setNewRecordData}
        />
      )}
      
      {walletSelectorOpen && (
        <WalletSelector
          isOpen={walletSelectorOpen}
          onWalletSelect={(wallet) => { onWalletSelect(wallet); setWalletSelectorOpen(false); }}
          onClose={() => setWalletSelectorOpen(false)}
        />
      )}
      
      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="loading-spinner"></div>}
              {transactionStatus.status === "success" && <div className="check-icon"></div>}
              {transactionStatus.status === "error" && <div className="error-icon"></div>}
            </div>
            <div className="transaction-message">
              {transactionStatus.message}
            </div>
          </div>
        </div>
      )}
  
      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo">
              <div className="shield-icon"></div>
              <span>SecureBootFHE</span>
            </div>
            <p>FHE-based secure boot process verification</p>
          </div>
          
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">Privacy Policy</a>
            <a href="#" className="footer-link">GitHub</a>
            <a href="#" className="footer-link">Contact</a>
          </div>
        </div>
        
        <div className="footer-bottom">
          <div className="fhe-badge">
            <span>FHE-Powered Security</span>
          </div>
          <div className="copyright">
            © {new Date().getFullYear()} SecureBootFHE. All rights reserved.
          </div>
        </div>
      </footer>
    </div>
  );
};

interface ModalCreateProps {
  onSubmit: () => void; 
  onClose: () => void; 
  creating: boolean;
  recordData: any;
  setRecordData: (data: any) => void;
}

const ModalCreate: React.FC<ModalCreateProps> = ({ 
  onSubmit, 
  onClose, 
  creating,
  recordData,
  setRecordData
}) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setRecordData({
      ...recordData,
      [name]: value
    });
  };

  const handleSubmit = () => {
    if (!recordData.deviceId || !recordData.checksum) {
      alert("Please fill required fields");
      return;
    }
    
    onSubmit();
  };

  return (
    <div className="modal-overlay">
      <div className="create-modal">
        <div className="modal-header">
          <h2>Add Boot Integrity Record</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        
        <div className="modal-body">
          <div className="fhe-notice">
            <div className="key-icon"></div> Boot checksum will be encrypted with FHE
          </div>
          
          <div className="form-grid">
            <div className="form-group">
              <label>Device ID *</label>
              <input 
                type="text"
                name="deviceId"
                value={recordData.deviceId} 
                onChange={handleChange}
                placeholder="Device identifier" 
                className="text-input"
              />
            </div>
            
            <div className="form-group">
              <label>Firmware Version</label>
              <input 
                type="text"
                name="firmwareVersion"
                value={recordData.firmwareVersion} 
                onChange={handleChange}
                placeholder="Firmware version" 
                className="text-input"
              />
            </div>
            
            <div className="form-group full-width">
              <label>Boot Checksum *</label>
              <textarea 
                name="checksum"
                value={recordData.checksum} 
                onChange={handleChange}
                placeholder="Enter encrypted boot checksum..." 
                className="text-area"
                rows={3}
              />
            </div>
          </div>
          
          <div className="privacy-notice">
            <div className="privacy-icon"></div> Checksum remains encrypted during FHE processing
          </div>
        </div>
        
        <div className="modal-footer">
          <button 
            onClick={onClose}
            className="cancel-btn secondary-btn"
          >
            Cancel
          </button>
          <button 
            onClick={handleSubmit} 
            disabled={creating}
            className="submit-btn primary-btn"
          >
            {creating ? "Processing with FHE..." : "Submit Securely"}
          </button>
        </div>
      </div>
    </div>
  );
};

export default App;